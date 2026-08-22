// Module 10 (admin client/subscription management + billing/refund + leads) smoke
// test. Self-contained: spawns its own app server with STRIPE_SECRET_KEY="" so
// stripeOn() is false and refunds exercise the LOCAL ledger path (the source of
// truth) — the Stripe-target-resolution path only matters when a real key is set
// and is verified in the human hardening pass. No Stripe calls are made.
//   node scripts/module10-admin-smoke.mjs
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 4108;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
let pass = 0,
  fail = 0;
const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Own server, Stripe explicitly disabled (empty string ⇒ dotenv won't override it).
const childEnv = { ...process.env, PORT: String(PORT), STRIPE_SECRET_KEY: "" };
const logFd = fs.openSync("/tmp/m10-server.log", "a");
const server = spawn("npx", ["tsx", "src/index.ts"], { env: childEnv, stdio: ["ignore", logFd, logFd] });

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function mkMember(tag) {
  const email = `m10${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  return { email, userId, access: r.json.access };
}
const tierOf = (userId) =>
  dbq(`SET ROLE ashta_app; SELECT set_config('app.user_id','${userId}',false); SELECT app.current_tier_rank();`).split("\n").pop().trim();

async function main() {
for (let i = 0; i < 40; i++) {
  try { const h = await fetch(BASE + "/health"); if (h.ok) break; } catch {}
  await sleep(250);
}
console.log("Admin management smoke test against", BASE);

let r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200 && r.json.access, "admin login");
const admin = r.json.access;

const sculpt = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);
const evolve = dbq(`SELECT id FROM programmes WHERE code='ashta_evolve'`);

// A client with an active sculpt sub + billing + progress + a self-set display name.
const A = await mkMember("a");
const subA = crypto.randomUUID();
dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,stripe_subscription_id,current_period_start,current_period_end,auto_renew,created_at,updated_at) VALUES ('${subA}','${A.userId}','${sculpt}','active','sub_local_${subA}',now(),now()+interval '30 days',true,now(),now())`);
const billWithUrl = crypto.randomUUID();
dbq(`INSERT INTO billing_records (id,user_id,subscription_id,programme_id,amount_minor,status,invoice_url,occurred_at,created_at) VALUES ('${billWithUrl}','${A.userId}','${subA}','${sculpt}',5900,'succeeded','https://stripe.example/inv_a',now(),now())`);
const billNoUrl = crypto.randomUUID();
dbq(`INSERT INTO billing_records (id,user_id,subscription_id,programme_id,amount_minor,status,occurred_at,created_at) VALUES ('${billNoUrl}','${A.userId}','${subA}','${sculpt}',5900,'succeeded',now(),now())`);

// ── AuthZ ──
r = await call("GET", "/admin/clients", null, null);
ok(r.status === 401, "clients list requires auth");
r = await call("GET", "/admin/clients", null, A.access);
ok(r.status === 403, "member forbidden from admin clients");

// ── Leads: public create + admin pipeline ──
const leadEmail = `lead-m10+${Date.now()}@example.com`;
r = await call("POST", "/leads", { fullName: "Lead M10", email: leadEmail, phone: "+441234", answers: { goal: "glow" } });
ok(r.status === 201 && r.json.leadId, "public POST /leads (no auth) → 201");
const leadId = r.json.leadId;
r = await call("GET", "/leads", null, null); // public leads is POST-only
ok(r.status === 404, "GET /leads is not a route (public is POST only)");
r = await call("GET", "/admin/leads?stage=applied", null, admin);
ok(r.status === 200 && r.json.items.some((l) => l.id === leadId), "admin lists leads by stage");
r = await call("GET", `/admin/leads/${leadId}`, null, admin);
ok(r.status === 200 && r.json.lead.email === leadEmail, "admin gets a lead");
r = await call("PATCH", `/admin/leads/${leadId}`, { stage: "contacted", notes: "called" }, admin);
ok(r.status === 200 && r.json.lead.stage === "contacted" && r.json.lead.notes === "called", "admin patches lead stage+notes");

// ── Clients roster ──
r = await call("GET", "/admin/clients", null, admin);
ok(r.status === 200 && typeof r.json.total === "number", "clients roster paginated envelope");
const rowA = r.json.items.find((c) => c.id === A.userId);
ok(rowA && rowA.tier === 2 && rowA.status === "active", "client shows tier 2 + active status");
ok(rowA && rowA.totalSpendMinor === 11800, "client total spend = 2×5900");
r = await call("GET", `/admin/clients?search=${encodeURIComponent(A.email)}`, null, admin);
ok(r.status === 200 && r.json.items.length === 1 && r.json.items[0].id === A.userId, "search filter matches email");
r = await call("GET", "/admin/clients?tier=2", null, admin);
ok(r.status === 200 && r.json.items.every((c) => c.tier === 2), "tier filter returns only tier 2");
r = await call("GET", "/admin/clients?status=active", null, admin);
ok(r.status === 200 && r.json.items.some((c) => c.id === A.userId), "status filter (active) includes client");

// ── Client profile + notes ──
r = await call("GET", `/admin/clients/${A.userId}`, null, admin);
ok(r.status === 200 && r.json.subscriptions.length === 1 && r.json.billing.length === 2, "profile has subs + billing");
ok(r.json.progressSummary && typeof r.json.progressSummary.entriesLogged === "number", "profile has progressSummary");
ok(r.json.notes === null, "profile notes null before set");
r = await call("PATCH", `/admin/clients/${A.userId}`, { phone: "+4477", notes: "VIP client" }, admin);
ok(r.status === 200 && r.json.user.phone === "+4477", "admin patches client phone");
ok(dbq(`SELECT notes FROM users WHERE id='${A.userId}'`) === "VIP client", "admin-private notes persisted (staff write)");
r = await call("GET", `/admin/clients/00000000-0000-0000-0000-000000000000`, null, admin);
ok(r.status === 404, "profile 404 for unknown client");

// ── Subscription controls ──
r = await call("POST", `/admin/clients/${A.userId}/subscription/change`, { programmeId: evolve }, admin);
ok(r.status === 200 && r.json.subscription.programmeId === evolve, "change → programme swapped to evolve");
ok(tierOf(A.userId) === "3", "tier now 3 after change to evolve");
r = await call("POST", `/admin/clients/${A.userId}/subscription/pause`, { subscriptionId: subA }, admin);
ok(r.status === 200 && r.json.subscription.status === "paused", "pause → status paused");
ok(tierOf(A.userId) === "0", "paused subscription drops tier to 0");
r = await call("POST", `/admin/clients/${A.userId}/subscription/pause`, { subscriptionId: subA }, admin);
ok(r.status === 409, "re-pause a paused sub → 409");
r = await call("POST", `/admin/clients/${A.userId}/subscription/cancel`, { subscriptionId: subA }, admin);
ok(r.status === 200 && r.json.subscription.cancelAtPeriodEnd === true, "cancel → cancelAtPeriodEnd true");
// cross-client guard
const B = await mkMember("b");
r = await call("POST", `/admin/clients/${B.userId}/subscription/pause`, { subscriptionId: subA }, admin);
ok(r.status === 404, "pause with a subId not owned by the client → 404");

// ── Billing + refund ──
r = await call("GET", `/admin/billing?programmeId=${evolve}`, null, admin);
ok(r.status === 200 && typeof r.json.total === "number", "billing list paginated + filtered");
r = await call("GET", `/admin/billing/${billWithUrl}/invoice`, null, admin);
ok(r.status === 200 && r.json.invoiceUrl === "https://stripe.example/inv_a", "invoice URL returned");
r = await call("GET", `/admin/billing/${billNoUrl}/invoice`, null, admin);
ok(r.status === 404, "no invoice URL → 404");
// full refund → original marked refunded
r = await call("POST", `/admin/billing/${billWithUrl}/refund`, {}, admin);
ok(r.status === 200 && r.json.billing.status === "refunded", "full refund marks original refunded");
ok(dbq(`SELECT status FROM billing_records WHERE id='${billWithUrl}'`) === "refunded", "original row status=refunded in DB");
r = await call("POST", `/admin/billing/${billWithUrl}/refund`, {}, admin);
ok(r.status === 409, "refund an already-refunded charge → 409");
// partial refund → negative row appended AND original locked (one refund per charge)
r = await call("POST", `/admin/billing/${billNoUrl}/refund`, { amountMinor: 2000 }, admin);
ok(r.status === 200 && r.json.billing.amountMinor === -2000 && r.json.billing.status === "refunded", "partial refund appends a -2000 refunded row");
ok(dbq(`SELECT status FROM billing_records WHERE id='${billNoUrl}'`) === "refunded", "partial refund also locks the original (refunded)");
// over-refund regression: a second refund on the same charge must be rejected
r = await call("POST", `/admin/billing/${billNoUrl}/refund`, { amountMinor: 2000 }, admin);
ok(r.status === 409, "second refund on the same charge → 409 (no over-refund)");
// total refunded for the charge never exceeds the charge amount
ok(dbq(`SELECT COALESCE(-SUM(amount_minor),0) FROM billing_records WHERE amount_minor < 0 AND description LIKE 'Partial refund of ${billNoUrl}'`) === "2000", "cumulative partial refund capped at the single 2000");
r = await call("POST", `/admin/billing/${billWithUrl}/refund`, { amountMinor: 999999 }, admin);
ok(r.status === 409 || r.status === 400, "refund on locked/over-amount → rejected");

// ── Cleanup ──
const like = "'m10%@example.com'";
dbq(`DELETE FROM billing_records WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM coaching_leads WHERE email='${leadEmail}'`);
dbq(`DELETE FROM users WHERE email LIKE ${like}`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    server.kill("SIGKILL");
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
