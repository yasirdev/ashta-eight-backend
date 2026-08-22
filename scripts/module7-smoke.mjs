// Module 7 (admin analytics) smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts
//   BASE=http://localhost:4100 node scripts/module7-smoke.mjs
// Asserts by BEFORE/AFTER delta so it's robust to whatever the dev DB already
// holds. Seeds 2 active subs on Ashta Sculpt + billing (1 succeeded, 1 refunded
// which must be excluded) + 1 coaching lead, then checks every endpoint.
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:4100";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
let pass = 0,
  fail = 0;

const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();

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
  const email = `m7${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  return { email, userId, access: r.json.access };
}

console.log("Analytics smoke test against", BASE);

let r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200, "admin login");
const admin = r.json.access;

const sculpt = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);
const sculptPrice = Number(dbq(`SELECT price_minor FROM programmes WHERE code='ashta_sculpt'`));
const sculptInterval = dbq(`SELECT billing_interval FROM programmes WHERE code='ashta_sculpt'`);
const monthlyEquiv = sculptInterval === "monthly" ? sculptPrice : sculptInterval === "annual" ? Math.trunc(sculptPrice / 12) : 0;

// ── AuthZ: member is forbidden ──
const M = await mkMember("z");
r = await call("GET", "/admin/analytics/summary", null, M.access);
ok(r.status === 403, "member forbidden from analytics");
r = await call("GET", "/admin/analytics/summary", null, null);
ok(r.status === 401, "unauthenticated → 401");

// ── Baseline (before seeding) ──
const base = (await call("GET", "/admin/analytics/summary", null, admin)).json;

// ── Seed 2 active subs + billing + lead ──
const A = await mkMember("a");
const B = await mkMember("b");
for (const u of [A, B]) {
  const sub = crypto.randomUUID();
  dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,created_at,updated_at) VALUES ('${sub}','${u.userId}','${sculpt}','active',now(),now()+interval '30 days',true,now(),now())`);
  dbq(`INSERT INTO billing_records (id,user_id,subscription_id,programme_id,amount_minor,status,occurred_at,created_at) VALUES (gen_random_uuid(),'${u.userId}','${sub}','${sculpt}',${sculptPrice},'succeeded',now(),now())`);
}
// A refunded record on the same programme — must be excluded from revenue.
dbq(`INSERT INTO billing_records (id,user_id,programme_id,amount_minor,status,occurred_at,created_at) VALUES (gen_random_uuid(),'${A.userId}','${sculpt}',9999,'refunded',now(),now())`);
// A coaching lead (stage defaults to 'applied').
dbq(`INSERT INTO coaching_leads (id,full_name,email,stage,created_at,updated_at) VALUES (gen_random_uuid(),'Lead M7','lead-m7+${Date.now()}@example.com','applied',now(),now())`);

// ── summary ──
r = await call("GET", "/admin/analytics/summary", null, admin);
const s = r.json;
ok(r.status === 200, "summary 200");
ok(s.activeMembers === base.activeMembers + 2, "activeMembers +2");
ok(s.mrr === base.mrr + 2 * monthlyEquiv, `mrr +${2 * monthlyEquiv} (monthly-equiv recurring)`);
ok(s.totalRevenueMinor === base.totalRevenueMinor + 2 * sculptPrice, "totalRevenueMinor +2×price (refunded excluded)");
ok(s.newMembers30d >= 3, "newMembers30d counts recent signups");
const prow = s.activeSubsByProgramme.find((p) => p.programmeId === sculpt);
ok(prow && prow.count >= 2, "activeSubsByProgramme includes sculpt ≥2");

// ── revenue ──
r = await call("GET", "/admin/analytics/revenue?interval=month", null, admin);
ok(r.status === 200 && Array.isArray(r.json.series), "revenue series returned");
ok(r.json.series.reduce((a, x) => a + x.revenueMinor, 0) === s.totalRevenueMinor, "revenue series sums to total (succeeded only)");
// bad interval rejected
r = await call("GET", "/admin/analytics/revenue?interval=year", null, admin);
ok(r.status === 400, "invalid interval → 400");
// from/to window that excludes everything → empty
r = await call("GET", "/admin/analytics/revenue?interval=month&from=2000-01-01&to=2000-02-01", null, admin);
ok(r.status === 200 && r.json.series.length === 0, "past-only window → empty series");

// ── subscribers ──
r = await call("GET", "/admin/analytics/subscribers?interval=month", null, admin);
ok(r.status === 200 && Array.isArray(r.json.series), "subscribers series returned");
const totalNew = r.json.series.reduce((a, x) => a + x.newSubs, 0);
ok(totalNew >= 2, "subscribers newSubs counts the 2 new active subs");
ok(r.json.series.every((x) => x.netActive === x.newSubs - x.churnedSubs), "netActive = newSubs - churnedSubs");

// ── programmes ──
r = await call("GET", "/admin/analytics/programmes", null, admin);
ok(r.status === 200 && r.json.items.length >= 4, "programmes lists all programmes");
const pr = r.json.items.find((x) => x.programmeId === sculpt);
ok(pr && pr.activeMembers >= 2, "programmes: sculpt activeMembers ≥2");
ok(pr && pr.revenueMinor >= 2 * sculptPrice, "programmes: sculpt revenue ≥ 2×price (refunded excluded)");

// ── pipeline ──
r = await call("GET", "/admin/analytics/pipeline", null, admin);
const applied = r.json.byStage.find((x) => x.stage === "applied");
ok(r.status === 200 && applied && applied.count >= 1, "pipeline: applied stage counted");

// ── Cleanup ──
dbq(`DELETE FROM billing_records WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm7%@example.com')`);
dbq(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm7%@example.com')`);
dbq(`DELETE FROM coaching_leads WHERE full_name='Lead M7'`);
dbq(`DELETE FROM users WHERE email LIKE 'm7%@example.com'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
