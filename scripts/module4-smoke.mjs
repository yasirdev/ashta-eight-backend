// Module 4 (subscription lifecycle) end-to-end smoke test. Run against a live
// server + DB (needs STRIPE_WEBHOOK_SECRET set — dummy is fine):
//   PORT=4100 npx tsx src/index.ts
//   BASE=http://localhost:4100 node scripts/module4-smoke.mjs
// Webhook lifecycle events are synthesised + signed offline (no Stripe API call).
import { execSync } from "node:child_process";
import Stripe from "stripe";

const BASE = process.env.BASE || "http://localhost:4100";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_dummy_local_secret";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
const stripe = new Stripe("sk_test_dummy_local");
let pass = 0,
  fail = 0,
  seq = 0;

const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
const unix = (d) => Math.floor(d.getTime() / 1000);
const days = (n) => new Date(Date.now() + n * 86400000);

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
async function sendEvent(type, object) {
  const payload = JSON.stringify({ id: `evt4_${seq++}_${Date.now()}`, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return call("POST", "/payments/webhook", null, null, Buffer.from(payload), { "stripe-signature": header, "content-type": "application/json" });
}
async function mkMember(tag) {
  const email = `payer4${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  return { email, userId, access: r.json.access };
}

console.log("Lifecycle smoke test against", BASE);

// Programme ids
let r = await call("GET", "/programmes");
const sculpt = r.json.items.find((p) => p.code === "ashta_sculpt"); // tier2, auto-renew
const evolve = r.json.items.find((p) => p.code === "ashta_evolve"); // tier3, NO auto-renew

// ── A) Full lifecycle on an auto-renew (Sculpt) subscription ──
const A = await mkMember("a");
const subA = "sub4a_" + Date.now();
r = await sendEvent("checkout.session.completed", {
  id: "cs4a", object: "checkout.session", subscription: subA, customer: "cus4a",
  invoice: "in4a_0", payment_intent: "pi4a", amount_total: 5900, currency: "gbp",
  metadata: { userId: A.userId, programmeId: sculpt.id, cohortBatch: "batch_1" },
});
ok(r.status === 200, "activate Sculpt via checkout.session.completed");

// GET /me/subscription requires auth
r = await call("GET", "/me/subscription");
ok(r.status === 401, "GET /me/subscription unauth → 401");
r = await call("GET", "/me/subscription", null, A.access);
ok(r.status === 200 && r.json.items.length === 1, "GET /me/subscription → 1 item");
const s0 = r.json.items[0];
ok(s0.status === "active" && s0.programme.code === "ashta_sculpt", "subscription active + programme summary");
ok(s0.stripeSubscriptionId === undefined && s0.stripeCustomerId === undefined, "no stripe ids leaked");
ok(s0.cancelAtPeriodEnd === false && s0.autoRenew === true, "Sculpt: autoRenew true, not cancelling");
const localSubId = s0.id;

// GET /me/billing (paginated envelope)
r = await call("GET", "/me/billing?limit=10", null, A.access);
ok(r.status === 200 && r.json.total === 1 && r.json.items.length === 1, "GET /me/billing → 1 record, envelope");
ok(r.json.page === 1 && r.json.limit === 10, "billing pagination echo");
ok(r.json.items[0].amountMinor === 5900, "billing amount 5900");
const billing0Id = r.json.items[0].id;

// invoice endpoint: checkout billing has no hosted url → 404
r = await call("GET", `/me/billing/${billing0Id}/invoice`, null, A.access);
ok(r.status === 404 && r.json.error.code === "no_invoice", "billing invoice (none) → 404 no_invoice");

// customer.subscription.updated → period sync
r = await sendEvent("customer.subscription.updated", {
  id: subA, object: "subscription", status: "active", customer: "cus4a",
  current_period_start: unix(days(0)), current_period_end: unix(days(30)),
  cancel_at_period_end: false, metadata: { userId: A.userId, programmeId: sculpt.id },
});
ok(r.status === 200, "customer.subscription.updated → 200");
ok(dbq(`SELECT (current_period_end > now()) FROM subscriptions WHERE stripe_subscription_id='${subA}'`) === "t", "period synced (future end)");

// invoice.paid → renewal billing (+invoiceUrl) + period advance + reminder reset
r = await sendEvent("invoice.paid", {
  id: "in4a_1", object: "invoice", subscription: subA, customer: "cus4a",
  amount_paid: 5900, currency: "gbp", hosted_invoice_url: "https://pay.stripe.test/inv/in4a_1",
  payment_intent: "pi4a_1", lines: { data: [{ period: { start: unix(days(30)), end: unix(days(60)) } }] },
});
ok(r.status === 200, "invoice.paid → 200");
ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${A.userId}'`) === "2", "renewal billing recorded (now 2)");
ok(dbq(`SELECT renewal_reminder_sent_at IS NULL FROM subscriptions WHERE stripe_subscription_id='${subA}'`) === "t", "reminder marker cleared on renewal");

// the renewal billing HAS an invoiceUrl → 200
r = await call("GET", "/me/billing?limit=10", null, A.access);
const renewalBill = r.json.items.find((b) => b.invoiceUrl);
r = await call("GET", `/me/billing/${renewalBill.id}/invoice`, null, A.access);
ok(r.status === 200 && r.json.invoiceUrl.startsWith("https://"), "billing invoice (renewal) → invoiceUrl");

// invoice.paid replay → idempotent (still 2 billing)
r = await sendEvent("invoice.paid", {
  id: "in4a_1", object: "invoice", subscription: subA, customer: "cus4a",
  amount_paid: 5900, currency: "gbp", lines: { data: [{ period: { start: unix(days(30)), end: unix(days(60)) } }] },
});
ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${A.userId}'`) === "2", "invoice.paid dedupe by invoice id");

// POST /me/subscription/cancel
r = await call("POST", "/me/subscription/cancel", { subscriptionId: localSubId }, A.access);
ok(r.status === 200 && r.json.subscription.cancelAtPeriodEnd === true, "cancel → cancelAtPeriodEnd true");
ok(r.json.subscription.autoRenew === false, "cancel → autoRenew false");
r = await call("POST", "/me/subscription/cancel", { subscriptionId: "00000000-0000-0000-0000-000000000000" }, A.access);
ok(r.status === 404, "cancel unknown subscription → 404 (ownership)");

// invoice.payment_failed → past_due
r = await sendEvent("invoice.payment_failed", { id: "in4a_2", object: "invoice", subscription: subA });
ok(r.status === 200 && dbq(`SELECT status FROM subscriptions WHERE stripe_subscription_id='${subA}'`) === "past_due", "payment_failed → past_due");

// tier while a sub exists but not active → 0 (past_due is not active)
ok(dbq(`SET ROLE ashta_app; SELECT set_config('app.user_id','${A.userId}',false); SELECT app.current_tier_rank();`).split("\n").pop().trim() === "0", "past_due → tier 0");

// customer.subscription.deleted → expired
r = await sendEvent("customer.subscription.deleted", { id: subA, object: "subscription", status: "canceled", metadata: { userId: A.userId, programmeId: sculpt.id } });
ok(r.status === 200 && dbq(`SELECT status FROM subscriptions WHERE stripe_subscription_id='${subA}'`) === "expired", "deleted → expired");

// ── B) Non-auto-renew reconciliation (Evolve): local cancelAtPeriodEnd forced true ──
const B = await mkMember("b");
const subB = "sub4b_" + Date.now();
r = await sendEvent("customer.subscription.created", {
  id: subB, object: "subscription", status: "active", customer: "cus4b",
  current_period_start: unix(days(0)), current_period_end: unix(days(30)),
  cancel_at_period_end: false, metadata: { userId: B.userId, programmeId: evolve.id },
});
ok(r.status === 200, "Evolve subscription.created → 200");
ok(dbq(`SELECT cancel_at_period_end FROM subscriptions WHERE stripe_subscription_id='${subB}'`) === "t", "non-auto-renew → cancelAtPeriodEnd forced true");
ok(dbq(`SELECT auto_renew FROM subscriptions WHERE stripe_subscription_id='${subB}'`) === "f", "non-auto-renew → autoRenew false");

// ── C) Renewal-reminder sweep (3-day window, once per period) ──
const C = await mkMember("c");
const subC = "sub4c_" + Date.now();
await sendEvent("checkout.session.completed", {
  id: "cs4c", object: "checkout.session", subscription: subC, customer: "cus4c",
  invoice: "in4c_0", payment_intent: "pi4c", amount_total: 5900, currency: "gbp",
  metadata: { userId: C.userId, programmeId: sculpt.id, cohortBatch: "batch_2" },
});
// put the period end 2 days out (inside the 3-day window), reminder unset
dbq(`UPDATE subscriptions SET current_period_end = now() + interval '2 days', renewal_reminder_sent_at = NULL WHERE stripe_subscription_id='${subC}'`);
const sweep1 = execSync(`npx tsx src/subscriptions/reminders.ts`, { encoding: "utf8" });
ok(/renewal reminders sent: 1/.test(sweep1), "sweep sends 1 reminder for due auto-renew sub");
ok(dbq(`SELECT renewal_reminder_sent_at IS NOT NULL FROM subscriptions WHERE stripe_subscription_id='${subC}'`) === "t", "reminder marker set");
const sweep2 = execSync(`npx tsx src/subscriptions/reminders.ts`, { encoding: "utf8" });
ok(/renewal reminders sent: 0/.test(sweep2), "sweep idempotent (0 on second run)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
