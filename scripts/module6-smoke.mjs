// Module 6 (bookings + Zoom) end-to-end smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts
//   BASE=http://localhost:4100 node scripts/module6-smoke.mjs
// Zoom is NOT configured locally, so bookings/sessions are created with null Zoom
// refs (best-effort) — that is asserted. No Zoom API calls are made.
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:4100";
const DB = process.env.DB_URL || "postgresql://yasiraziz@localhost:5432/ashta_eight";
let pass = 0,
  fail = 0;

const ok = (c, l) => (c ? (pass++, console.log("  ✓", l)) : (fail++, console.error("  ✗ FAIL:", l)));
const dbq = (sql) => execSync(`psql "${DB}" -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

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
async function mkMember(tag, batch) {
  const email = `m6${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  if (batch) {
    const sculpt = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);
    dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,cohort_batch,created_at,updated_at) VALUES (gen_random_uuid(),'${userId}','${sculpt}','active',now(),now()+interval '30 days',true,'${batch}',now(),now())`);
  }
  return { email, userId, access: r.json.access };
}

console.log("Bookings/Zoom smoke test against", BASE);

let r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200, "admin login");
const admin = r.json.access;
const A = await mkMember("a", "batch_1");
const B = await mkMember("b", null);

// ── Admin: coaching slots ──
r = await call("POST", "/admin/coaching/slots", { startsAt: iso(7 * DAY), endsAt: iso(7 * DAY + 3_600_000), capacity: 1 }, admin);
ok(r.status === 201 && r.json.slot?.id, "admin create coaching slot (cap 1)");
const slot1 = r.json.slot.id;
r = await call("POST", "/admin/coaching/slots", { startsAt: iso(2 * DAY), endsAt: iso(DAY) }, admin);
ok(r.status === 400, "reject slot with endsAt before startsAt");
r = await call("GET", "/admin/coaching/slots", null, admin);
ok(r.status === 200 && r.json.items.some((s) => s.id === slot1 && s.bookedCount === 0), "admin lists slot with bookedCount");

// member forbidden from admin create
r = await call("POST", "/admin/coaching/slots", { startsAt: iso(DAY), endsAt: iso(DAY + 3600_000) }, A.access);
ok(r.status === 403, "member forbidden from admin slot create");

// ── Member: coaching booking + capacity ──
r = await call("GET", "/coaching/slots", null, A.access);
ok(r.status === 200 && r.json.items.some((s) => s.id === slot1), "member sees open slot");
r = await call("POST", "/coaching/bookings", { slotId: slot1 }, A.access);
ok(r.status === 201 && r.json.booking.status === "booked" && r.json.booking.zoomJoinUrl === null, "member books slot (Zoom null, best-effort)");
const bookingA = r.json.booking.id;
ok(dbq(`SELECT status FROM coaching_slots WHERE id='${slot1}'`) === "full", "cap-1 slot flips to full");
r = await call("POST", "/coaching/bookings", { slotId: slot1 }, B.access);
ok(r.status === 409, "second member can't book a full slot");
r = await call("GET", "/me/bookings?type=coaching", null, A.access);
ok(r.status === 200 && r.json.items.some((b) => b.id === bookingA), "member sees own booking");

// cancel frees the slot
r = await call("POST", `/me/bookings/${bookingA}/cancel`, null, A.access);
ok(r.status === 200 && r.json.booking.status === "canceled", "member cancels booking");
ok(dbq(`SELECT status FROM coaching_slots WHERE id='${slot1}'`) === "open", "cancel reopens the slot");
r = await call("POST", `/me/bookings/${bookingA}/cancel`, null, A.access);
ok(r.status === 409, "re-cancel a canceled booking → 409");
r = await call("POST", `/me/bookings/${bookingA}/cancel`, null, B.access);
ok(r.status === 404, "cancel someone else's booking → 404");

// B can now grab the freed spot
r = await call("POST", "/coaching/bookings", { slotId: slot1 }, B.access);
ok(r.status === 201, "freed spot is bookable by B");

// past slot can't be booked (id generated here so psql doesn't return the command tag)
const pastSlot = crypto.randomUUID();
dbq(`INSERT INTO coaching_slots (id,owner_id,starts_at,ends_at,capacity,status,created_at,updated_at) SELECT '${pastSlot}',(SELECT id FROM users WHERE email='admin@ashta-eight.com'),now()-interval '2 days',now()-interval '1 day',1,'open',now(),now()`);
r = await call("POST", "/coaching/bookings", { slotId: pastSlot }, A.access);
ok(r.status === 409 && r.json.error?.code === "slot_past", "can't book a past slot");

// capacity-2 concurrency: two parallel bookings both succeed, third fails
r = await call("POST", "/admin/coaching/slots", { startsAt: iso(10 * DAY), endsAt: iso(10 * DAY + 3600_000), capacity: 2 }, admin);
const slot2 = r.json.slot.id;
const C = await mkMember("c", null);
const D = await mkMember("d", null);
const [rc, rd] = await Promise.all([
  call("POST", "/coaching/bookings", { slotId: slot2 }, C.access),
  call("POST", "/coaching/bookings", { slotId: slot2 }, D.access),
]);
ok(rc.status === 201 && rd.status === 201, "two parallel bookings both fit capacity 2");
r = await call("POST", "/coaching/bookings", { slotId: slot2 }, A.access);
ok(r.status === 409 && dbq(`SELECT status FROM coaching_slots WHERE id='${slot2}'`) === "full", "third booking rejected; slot full");

// The real oversell test: cap-1 slot, two parallel bookings → exactly one wins.
r = await call("POST", "/admin/coaching/slots", { startsAt: iso(11 * DAY), endsAt: iso(11 * DAY + 3600_000), capacity: 1 }, admin);
const slot3 = r.json.slot.id;
const E = await mkMember("e", null);
const F = await mkMember("f", null);
const [re, rf] = await Promise.all([
  call("POST", "/coaching/bookings", { slotId: slot3 }, E.access),
  call("POST", "/coaching/bookings", { slotId: slot3 }, F.access),
]);
const wins = [re.status, rf.status].filter((s) => s === 201).length;
const rejects = [re.status, rf.status].filter((s) => s === 409).length;
ok(wins === 1 && rejects === 1 && Number(dbq(`SELECT count(*) FROM bookings WHERE coaching_slot_id='${slot3}' AND status='booked'`)) === 1, "cap-1 slot: parallel bookings never oversell (lock holds)");

// ── Admin: delete guard ──
r = await call("DELETE", `/admin/coaching/slots/${slot2}`, null, admin);
ok(r.status === 409 && r.json.error?.code === "has_bookings", "can't delete a slot with active bookings");

// ── Live cohort ──
r = await call("POST", "/admin/live-cohort/sessions", { batch: "batch_1", title: "Week 1 Live", startsAt: iso(3 * DAY) }, admin);
ok(r.status === 201 && r.json.session.zoomMeetingId === null, "admin create live-cohort session (Zoom null)");
const sess1 = r.json.session.id;
r = await call("POST", "/admin/live-cohort/sessions", { batch: "batch_2", startsAt: iso(3 * DAY) }, admin);
const sess2 = r.json.session.id;
r = await call("GET", "/live-cohort/sessions", null, A.access);
ok(r.status === 200 && r.json.items.some((s) => s.id === sess1) && !r.json.items.some((s) => s.id === sess2), "batch_1 member sees only batch_1 session");
r = await call("GET", "/live-cohort/sessions", null, B.access);
ok(r.status === 200 && r.json.items.length === 0, "member with no cohort enrolment sees no sessions");
r = await call("PATCH", `/admin/live-cohort/sessions/${sess1}`, { title: "Week 1 — updated" }, admin);
ok(r.status === 200 && r.json.session.title === "Week 1 — updated", "admin PATCH session");
r = await call("GET", "/admin/live-cohort/sessions?batch=batch_1", null, admin);
ok(r.status === 200 && r.json.items.some((s) => s.id === sess1), "admin filters sessions by batch");
r = await call("DELETE", `/admin/live-cohort/sessions/${sess2}`, null, admin);
ok(r.status === 200 && r.json.ok, "admin DELETE session");

// Cleanup
dbq(`DELETE FROM bookings WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm6%@example.com')`);
dbq(`DELETE FROM coaching_slots WHERE id IN ('${slot1}','${slot2}','${slot3}','${pastSlot}')`);
dbq(`DELETE FROM live_cohort_sessions WHERE id IN ('${sess1}','${sess2}')`);
dbq(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm6%@example.com')`);
dbq(`DELETE FROM users WHERE email LIKE 'm6%@example.com'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
