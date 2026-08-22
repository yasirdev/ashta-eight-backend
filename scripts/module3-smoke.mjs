// Module 3 (Stripe) end-to-end smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts   (needs STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set)
//   BASE=http://localhost:4100 node scripts/module3-smoke.mjs
// The webhook is the security-critical path and is FULLY testable offline via
// Stripe's generateTestHeaderString (no Stripe API call). Checkout-session
// creation calls the live Stripe API, so with dummy keys we only assert its
// guard paths (401 unauth, 409 no-price); full checkout needs real test keys.
import { execSync } from "node:child_process";
import Stripe from "stripe";

const BASE = process.env.BASE || "http://localhost:4100";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_dummy_local_secret";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
const stripe = new Stripe("sk_test_dummy_local");
let pass = 0,
  fail = 0;

function ok(cond, label) {
  if (cond) (pass++, console.log("  ✓", label));
  else (fail++, console.error("  ✗ FAIL:", label));
}
function dbq(sql) {
  return execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
}
async function call(method, path, body, token, raw, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(raw ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const email = `payer+${Date.now()}@example.com`;
const pw = "hunter2pw!";
console.log("Stripe smoke test against", BASE);

// Register + login a member
let r = await call("POST", "/auth/register", { email, password: pw });
const userId = r.json?.userId;
ok(r.status === 201 && userId, "register member");
r = await call("POST", "/auth/login", { email, password: pw });
const access = r.json?.access;
ok(!!access, "login member");

// Programmes catalogue (public)
r = await call("GET", "/programmes");
ok(r.status === 200 && Array.isArray(r.json.items) && r.json.items.length === 4, "GET /programmes → 4 active");
ok(r.json.items.every((p) => p.stripePriceId === undefined), "programmes never expose stripePriceId");
const sculpt = r.json.items.find((p) => p.code === "ashta_sculpt");
ok(sculpt && sculpt.tierRank === 2 && sculpt.priceMinor === 5900, "ashta_sculpt tier 2 / £59");

r = await call("GET", `/programmes/${sculpt.id}`);
ok(r.status === 200 && r.json.programme.id === sculpt.id, "GET /programmes/:id");
r = await call("GET", `/programmes/00000000-0000-0000-0000-000000000000`);
ok(r.status === 404, "GET /programmes/:badId → 404");

// Checkout-session guards (full flow needs real Stripe test keys)
r = await call("POST", "/payments/checkout-session", { programmeId: sculpt.id });
ok(r.status === 401, "checkout-session unauth → 401");
r = await call("POST", "/payments/checkout-session", { programmeId: sculpt.id }, access);
ok(r.status === 409 && r.json.error.code === "not_purchasable", "checkout-session, no stripe price → 409");
r = await call("POST", "/payments/checkout-session", { programmeId: "not-a-uuid" }, access);
ok(r.status === 400, "checkout-session bad body → 400");

// ── Webhook: bad signature → 400 ──
r = await call("POST", "/payments/webhook", null, null, Buffer.from("{}"), {
  "stripe-signature": "t=1,v1=deadbeef",
  "content-type": "application/json",
});
ok(r.status === 400 && r.json.error.code === "invalid_signature", "webhook bad signature → 400");

// ── Webhook: valid checkout.session.completed → activates sub + billing + tier ──
const evtId = "evt_test_" + Date.now();
const subId = "sub_test_" + Date.now();
const event = {
  id: evtId,
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_1",
      object: "checkout.session",
      subscription: subId,
      customer: "cus_test_1",
      invoice: "in_test_" + Date.now(),
      payment_intent: "pi_test_1",
      amount_total: 5900,
      currency: "gbp",
      metadata: { userId, programmeId: sculpt.id, cohortBatch: "batch_1" },
    },
  },
};
const payload = JSON.stringify(event);
const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
r = await call("POST", "/payments/webhook", null, null, Buffer.from(payload), {
  "stripe-signature": header,
  "content-type": "application/json",
});
ok(r.status === 200 && r.json.received === true, "webhook valid event → 200 received");

// DB assertions
const subCount = dbq(
  `SELECT count(*) FROM subscriptions WHERE user_id='${userId}' AND status='active' AND stripe_subscription_id='${subId}'`,
);
ok(subCount === "1", "subscription activated (1 active row)");
ok(dbq(`SELECT cohort_batch FROM subscriptions WHERE stripe_subscription_id='${subId}'`) === "batch_1", "cohort_batch recorded");
const billCount = dbq(`SELECT count(*) FROM billing_records WHERE user_id='${userId}'`);
ok(billCount === "1", "billing record created (1)");
ok(dbq(`SELECT amount_minor FROM billing_records WHERE user_id='${userId}'`) === "5900", "billing amount 5900");
ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${userId}' AND (stripe_charge_id IS NOT NULL AND stripe_charge_id ~ '^[0-9]{12,}')`) === "0", "no card/PAN data stored");
// Tier granted at the DB level (RLS current_tier_rank under the member's session)
const tier = dbq(
  `SET ROLE ashta_app; SELECT set_config('app.user_id','${userId}',false); SELECT app.current_tier_rank();`,
)
  .split("\n")
  .pop()
  .trim();
ok(tier === "2", "RLS current_tier_rank() = 2 (tier granted)");

// ── Webhook idempotency: sequential replay → duplicate ack, no double side effects ──
r = await call("POST", "/payments/webhook", null, null, Buffer.from(payload), {
  "stripe-signature": header,
  "content-type": "application/json",
});
ok(r.status === 200 && r.json.duplicate === true, "webhook replay → 200 duplicate");
ok(dbq(`SELECT count(*) FROM subscriptions WHERE stripe_subscription_id='${subId}'`) === "1", "replay: still 1 subscription");
ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${userId}'`) === "1", "replay: still 1 billing record");

// ── CONCURRENT duplicate delivery of a NEW event → advisory lock serializes,
//    exactly one activation + one billing (the MAJOR the Reviewer flagged). ──
const cEvt = "evt_conc_" + Date.now();
const cSub = "sub_conc_" + Date.now();
const cEmail = `conc+${Date.now()}@example.com`;
await call("POST", "/auth/register", { email: cEmail, password: pw });
const cUserId = dbq(`SELECT id FROM users WHERE email='${cEmail}'`);
const cEvent = JSON.stringify({
  id: cEvt, object: "event", type: "checkout.session.completed",
  data: { object: {
    id: "cs_conc", object: "checkout.session", subscription: cSub, customer: "cus_conc",
    invoice: "in_conc_" + Date.now(), payment_intent: "pi_conc", amount_total: 5900, currency: "gbp",
    metadata: { userId: cUserId, programmeId: sculpt.id, cohortBatch: "" },
  } },
});
const cHeader = stripe.webhooks.generateTestHeaderString({ payload: cEvent, secret: WEBHOOK_SECRET });
const fire = () => call("POST", "/payments/webhook", null, null, Buffer.from(cEvent), {
  "stripe-signature": cHeader, "content-type": "application/json",
});
const results = await Promise.all([fire(), fire(), fire()]);
ok(results.every((x) => x.status === 200), "concurrent x3 → all 200");
ok(dbq(`SELECT count(*) FROM subscriptions WHERE stripe_subscription_id='${cSub}'`) === "1", "concurrent: exactly 1 subscription");
ok(dbq(`SELECT count(*) FROM billing_records WHERE user_id='${cUserId}'`) === "1", "concurrent: exactly 1 billing record (no double)");
ok(dbq(`SELECT count(*) FROM webhook_events WHERE stripe_event_id='${cEvt}' AND processed_at IS NOT NULL`) === "1", "concurrent: 1 processed webhook_event");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
