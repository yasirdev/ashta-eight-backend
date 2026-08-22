// Module 8 (notifications / FCM) smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts
//   BASE=http://localhost:4100 node scripts/module8-smoke.mjs
// FCM is NOT configured locally, so pushes are a no-op — the in-app notification
// ROWS are still written (sent_at stays null); that is asserted. No FCM calls made.
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:4100";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
let pass = 0,
  fail = 0;

const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
const run = (script) => execSync(`npx tsx ${script}`, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}

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
async function mkMember(tag, { programme } = {}) {
  const email = `m8${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  if (programme) {
    const pid = dbq(`SELECT id FROM programmes WHERE code='${programme}'`);
    dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,created_at,updated_at) VALUES (gen_random_uuid(),'${userId}','${pid}','active',now(),now()+interval '30 days',true,now(),now())`);
  }
  return { email, userId, access: r.json.access };
}

console.log("Notifications/FCM smoke test against", BASE);

let r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200, "admin login");
const admin = r.json.access;
const sculptTier = Number(dbq(`SELECT tier_rank FROM programmes WHERE code='ashta_sculpt'`));

// ── AuthZ ──
r = await call("POST", "/me/devices", { fcmToken: "x", platform: "ios" }, null);
ok(r.status === 401, "device register requires auth");
r = await call("GET", "/me/notifications", null, null);
ok(r.status === 401, "notifications list requires auth");

// ── Device registration (upsert) ──
const M = await mkMember("m", { programme: "ashta_sculpt" });
const tok1 = `tok-m8-${Date.now()}-1`;
r = await call("POST", "/me/devices", { fcmToken: tok1, platform: "ios" }, M.access);
ok(r.status === 200 && r.json.ok, "register device token");
ok(dbq(`SELECT count(*) FROM device_tokens WHERE fcm_token='${tok1}'`) === "1", "device row created");
r = await call("POST", "/me/devices", { fcmToken: tok1, platform: "android" }, M.access);
ok(r.status === 200 && dbq(`SELECT count(*) FROM device_tokens WHERE fcm_token='${tok1}'`) === "1", "re-register same token upserts (no dup)");
ok(dbq(`SELECT platform FROM device_tokens WHERE fcm_token='${tok1}'`) === "android", "re-register updates platform");
r = await call("POST", "/me/devices", { fcmToken: "", platform: "ios" }, M.access);
ok(r.status === 400, "empty token rejected");
// second token, then delete it
const tok2 = `tok-m8-${Date.now()}-2`;
await call("POST", "/me/devices", { fcmToken: tok2, platform: "ios" }, M.access);
r = await call("DELETE", `/me/devices/${tok2}`, null, M.access);
ok(r.status === 200 && dbq(`SELECT count(*) FROM device_tokens WHERE fcm_token='${tok2}'`) === "0", "delete own device token");

// ── new_content: publish fan-out to entitled members only ──
async function mkContent(title, tierRank) {
  const cr = await call("POST", "/admin/content", { type: "audio", pillar: "sculpt", title, requiredTierRank: tierRank, s3Key: `audio/${crypto.randomUUID()}.mp3` }, admin);
  return cr.json.content.id;
}
const visibleId = await mkContent("M8 visible", sculptTier); // M (tier=sculptTier) entitled
const aboveId = await mkContent("M8 above tier", sculptTier + 1); // M not entitled
await call("POST", `/admin/content/${visibleId}/publish`, { publish: true }, admin);
await call("POST", `/admin/content/${aboveId}/publish`, { publish: true }, admin);

const gotVisible = await waitFor(async () => {
  const g = await call("GET", "/me/notifications", null, M.access);
  return g.json.items?.some((n) => n.type === "new_content" && n.data?.contentId === visibleId);
});
ok(gotVisible, "entitled member notified of new content at their tier");
await sleep(400); // let any (incorrect) above-tier fan-out settle
const g = await call("GET", "/me/notifications", null, M.access);
ok(!g.json.items.some((n) => n.data?.contentId === aboveId), "member NOT notified of above-tier content");
const vis = g.json.items.find((n) => n.data?.contentId === visibleId);
ok(vis && vis.sentAt === null, "notification row written but sent_at null (FCM unconfigured)");

// republish (already published) must not re-notify
await call("POST", `/admin/content/${visibleId}/publish`, { publish: true }, admin);
await sleep(400);
const g2 = await call("GET", "/me/notifications", null, M.access);
ok(g2.json.items.filter((n) => n.data?.contentId === visibleId).length === 1, "re-publish of already-published content does not re-notify");

// ── mark read ──
r = await call("POST", `/me/notifications/${vis.id}/read`, null, M.access);
ok(r.status === 200 && dbq(`SELECT read_at IS NOT NULL FROM notifications WHERE id='${vis.id}'`) === "t", "mark notification read");
r = await call("POST", `/me/notifications/${crypto.randomUUID()}/read`, null, M.access);
ok(r.status === 404, "mark-read on non-existent → 404");
// can't read someone else's notification (RLS own-only)
const other = await mkMember("o");
r = await call("POST", `/me/notifications/${vis.id}/read`, null, other.access);
ok(r.status === 404, "cannot mark another member's notification read");

// ── renewal_reminder sweep ──
const Rm = await mkMember("r");
const rsub = crypto.randomUUID();
const sculpt = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);
dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,cancel_at_period_end,created_at,updated_at) VALUES ('${rsub}','${Rm.userId}','${sculpt}','active',now(),now()+interval '2 days',true,false,now(),now())`);
const rOut = run("src/subscriptions/reminders.ts");
ok(dbq(`SELECT count(*) FROM notifications WHERE user_id='${Rm.userId}' AND type='renewal_reminder'`) === "1", "renewal sweep pushes one reminder");
ok(dbq(`SELECT renewal_reminder_sent_at IS NOT NULL FROM subscriptions WHERE id='${rsub}'`) === "t", "renewal marker set");
run("src/subscriptions/reminders.ts"); // re-run
ok(dbq(`SELECT count(*) FROM notifications WHERE user_id='${Rm.userId}' AND type='renewal_reminder'`) === "1", "renewal sweep idempotent (no duplicate)");

// ── session_reminder sweep (coaching) ──
const S = await mkMember("s");
const bk = crypto.randomUUID();
dbq(`INSERT INTO bookings (id,user_id,type,status,scheduled_start,created_at,updated_at) VALUES ('${bk}','${S.userId}','coaching','booked',now()+interval '12 hours',now(),now())`);
run("src/notifications/session-reminders.ts");
ok(dbq(`SELECT count(*) FROM notifications WHERE user_id='${S.userId}' AND type='session_reminder'`) === "1", "session sweep pushes one reminder");
ok(dbq(`SELECT reminder_sent_at IS NOT NULL FROM bookings WHERE id='${bk}'`) === "t", "booking reminder marker set");
run("src/notifications/session-reminders.ts"); // re-run
ok(dbq(`SELECT count(*) FROM notifications WHERE user_id='${S.userId}' AND type='session_reminder'`) === "1", "session sweep idempotent (no duplicate)");
// a far-future booking is not swept yet
const far = crypto.randomUUID();
dbq(`INSERT INTO bookings (id,user_id,type,status,scheduled_start,created_at,updated_at) VALUES ('${far}','${S.userId}','coaching','booked',now()+interval '5 days',now(),now())`);
run("src/notifications/session-reminders.ts");
ok(dbq(`SELECT reminder_sent_at IS NULL FROM bookings WHERE id='${far}'`) === "t", "booking outside lead window not reminded");

// ── Cleanup ──
const like = "'m8%@example.com'";
dbq(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM device_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM bookings WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`);
dbq(`DELETE FROM content WHERE title LIKE 'M8 %'`);
dbq(`DELETE FROM users WHERE email LIKE ${like}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
