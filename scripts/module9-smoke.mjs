// Module 9 (email / Mailchimp Transactional) smoke test. Self-contained: it spawns
// a local capture server standing in for the Mandrill endpoint (via the
// MAILCHIMP_API_URL seam) AND its own app server with email configured to point at
// it, so outbound emails are directly observable. Then asserts the verify email,
// the payment RECEIPT (exactly once, and NOT re-sent on a Stripe replay), and the
// renewal-reminder email.
//   node scripts/module9-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import Stripe from "stripe";

const PORT = 4109;
const CAP_PORT = 4110;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = "whsec_test_dummy_local_secret";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
const stripe = new Stripe("sk_test_dummy_local");
let pass = 0,
  fail = 0;
const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Capture server (fake Mandrill) ──
const captured = [];
const capServer = http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try { captured.push(JSON.parse(body)); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ status: "sent" }]));
    });
  })
  .listen(CAP_PORT);

const childEnv = {
  ...process.env,
  PORT: String(PORT),
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  MAILCHIMP_TRANSACTIONAL_API_KEY: "md-test-key",
  EMAIL_FROM: "no-reply@ashta-eight.test",
  EMAIL_FROM_NAME: "Ashta Eight",
  MAILCHIMP_API_URL: `http://localhost:${CAP_PORT}/send`,
};

const logFd = fs.openSync("/tmp/m9-server.log", "a");
const server = spawn("npx", ["tsx", "src/index.ts"], { env: childEnv, stdio: ["ignore", logFd, logFd] });

async function call(method, path, body, token, raw, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(raw ? {} : { "content-type": "application/json" }), ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const mailsTo = (addr) => captured.filter((m) => m.message?.to?.[0]?.email === addr);
const subjectsFor = (addr) => mailsTo(addr).map((m) => m.message.subject);
// Run a cron script as an async child (NOT execSync — that blocks this event loop,
// which would deadlock the capture server the child POSTs to).
const runCron = (script) =>
  new Promise((resolve, reject) => {
    const c = spawn("npx", ["tsx", script], { env: childEnv, stdio: "ignore" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
    c.on("error", reject);
  });

async function main() {
  // wait for boot
  for (let i = 0; i < 40; i++) {
    try { const h = await fetch(BASE + "/health"); if (h.ok) break; } catch {}
    await sleep(250);
  }
  console.log("Email/Mailchimp smoke test against", BASE);

  const email = `m9payer+${Date.now()}@example.com`;
  const sculptId = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);

  // ── register → verify email dispatched through the real transport ──
  let r = await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  ok(r.status === 201, "register member");
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  ok(subjectsFor(email).some((s) => /verify/i.test(s)), "verify email sent via Mailchimp transport");

  // ── payment webhook → receipt sent exactly once ──
  const evtId = "evt_m9_" + Date.now();
  const subId = "sub_m9_" + Date.now();
  const event = {
    id: evtId, object: "event", type: "checkout.session.completed",
    data: { object: {
      id: "cs_m9", object: "checkout.session", subscription: subId, customer: "cus_m9",
      invoice: "in_m9_" + Date.now(), payment_intent: "pi_m9", amount_total: 5900, currency: "gbp",
      metadata: { userId, programmeId: sculptId, cohortBatch: "batch_1" },
    } },
  };
  const payload = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const fire = () => call("POST", "/payments/webhook", null, null, Buffer.from(payload), { "stripe-signature": sig, "content-type": "application/json" });

  r = await fire();
  ok(r.status === 200 && r.json.received === true, "checkout webhook → 200");
  ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${userId}'`) === "1", "billing record created");
  const receipts = () => subjectsFor(email).filter((s) => /receipt/i.test(s));
  ok(receipts().length === 1, "exactly one receipt email sent");
  const receiptMail = mailsTo(email).find((m) => /receipt/i.test(m.message.subject));
  ok(/GBP 59\.00/.test(receiptMail.message.subject + receiptMail.message.text), "receipt shows GBP 59.00");

  // ── Stripe REPLAY of the same event → no duplicate billing, no second receipt ──
  r = await fire();
  ok(r.status === 200 && r.json.duplicate === true, "replay acked as duplicate");
  ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${userId}'`) === "1", "still one billing record (idempotent)");
  ok(receipts().length === 1, "still exactly one receipt (no double-charge email)");

  // ── renewal reminder email (via the sweep cron) ──
  const rEmail = `m9renew+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email: rEmail, password: "hunter2pw!" });
  const rUser = dbq(`SELECT id FROM users WHERE email='${rEmail}'`);
  dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,cancel_at_period_end,created_at,updated_at) VALUES (gen_random_uuid(),'${rUser}','${sculptId}','active',now(),now()+interval '2 days',true,false,now(),now())`);
  await runCron("src/subscriptions/reminders.ts");
  ok(subjectsFor(rEmail).some((s) => /renews soon/i.test(s)), "renewal reminder email sent");
  ok(dbq(`SELECT count(*) FROM notifications WHERE user_id='${rUser}' AND type='renewal_reminder'`) === "1", "renewal push logged alongside email");

  // ── Cleanup ──
  dbq(`DELETE FROM billing_records WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm9%@example.com')`);
  dbq(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm9%@example.com')`);
  dbq(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm9%@example.com')`);
  dbq(`DELETE FROM webhook_events WHERE stripe_event_id LIKE 'evt_m9%'`);
  dbq(`DELETE FROM users WHERE email LIKE 'm9%@example.com'`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    server.kill("SIGKILL");
    capServer.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
