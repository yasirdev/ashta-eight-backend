// Module 5 (content + media) end-to-end smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts
//   BASE=http://localhost:4100 node scripts/module5-smoke.mjs
// S3/Mux keys are NOT set locally, so the signer functions 503 — that is asserted
// (it proves the tier gate passed and reached the signer). No AWS/Mux calls made.
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
  const email = `m5${tag}+${Date.now()}@example.com`;
  await call("POST", "/auth/register", { email, password: "hunter2pw!" });
  const r = await call("POST", "/auth/login", { email, password: "hunter2pw!" });
  const userId = dbq(`SELECT id FROM users WHERE email='${email}'`);
  return { email, userId, access: r.json.access };
}

console.log("Content/media smoke test against", BASE);

// Admin token (seeded admin, 2FA not enrolled → tokens directly).
let r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200 && r.json.access, "admin login");
const admin = r.json.access;

// ── Admin: media presign guards (no S3/Mux keys locally) ──
r = await call("POST", "/admin/uploads/presign", { filename: "x.mp3", contentType: "audio/mpeg", category: "audio", sizeBytes: 5_000_000 }, admin);
ok(r.status === 503 && r.json.error?.code === "s3_unconfigured", "presign audio → 503 (unconfigured, guard reached)");
r = await call("POST", "/admin/uploads/presign", { filename: "x.exe", contentType: "application/x-msdownload", category: "audio", sizeBytes: 1000 }, admin);
ok(r.status === 400 && r.json.error?.code === "unsupported_type", "presign rejects disallowed content-type (400 before signer)");
r = await call("POST", "/admin/uploads/presign", { filename: "x", contentType: "audio/mpeg", category: "bogus", sizeBytes: 1000 }, admin);
ok(r.status === 400, "presign rejects bad category");
r = await call("POST", "/admin/uploads/presign", { filename: "big.mp3", contentType: "audio/mpeg", category: "audio", sizeBytes: 999_000_000 }, admin);
ok(r.status === 400 && r.json.error?.code === "size_exceeded", "presign rejects oversize upload (size cap enforced)");
r = await call("POST", "/admin/uploads/presign", { filename: "x.mp3", contentType: "audio/mpeg", category: "audio" }, admin);
ok(r.status === 400, "presign requires sizeBytes");
r = await call("POST", "/admin/uploads/video-upload-url", { filename: "clip.mp4" }, admin);
ok(r.status === 503 && r.json.error?.code === "video_unconfigured", "video-upload-url → 503 (unconfigured)");

// non-admin can't presign
const outsider = await mkMember("out");
r = await call("POST", "/admin/uploads/presign", { filename: "x.mp3", contentType: "audio/mpeg", category: "audio" }, outsider.access);
ok(r.status === 403, "member forbidden from admin presign");

// ── Admin: create content ──
r = await call("POST", "/admin/content", { type: "audio", pillar: "sculpt", title: "Tier2 Audio", requiredTierRank: 2, s3Key: "audio/seed-audio.mp3", durationSeconds: 600 }, admin);
ok(r.status === 201 && r.json.content?.id, "create tier-2 audio");
const audioId = r.json.content.id;
r = await call("POST", "/admin/content", { type: "video", pillar: "align", title: "Tier3 Video", requiredTierRank: 3, videoRef: "mux_playback_abc" }, admin);
ok(r.status === 201, "create tier-3 video");
const videoId = r.json.content.id;
r = await call("POST", "/admin/content", { type: "video", pillar: "align", title: "Free Video", requiredTierRank: 0, videoRef: "mux_free_xyz" }, admin);
const freeVideoId = r.json.content.id;
r = await call("POST", "/admin/content", { type: "video", pillar: "align", title: "Bad", requiredTierRank: 1, videoRef: "v", s3Key: "audio/a.mp3" }, admin);
ok(r.status === 400, "create rejects video with BOTH refs (XOR invariant)");
r = await call("POST", "/admin/content", { type: "audio", pillar: "align", title: "Bad2", requiredTierRank: 1 }, admin);
ok(r.status === 400, "create rejects audio with no s3Key");

// Publish all three
for (const id of [audioId, videoId, freeVideoId]) await call("POST", `/admin/content/${id}/publish`, { publish: true }, admin);
ok(dbq(`SELECT published_at IS NOT NULL FROM content WHERE id='${audioId}'`) === "t", "publish sets published_at");

// Admin listing incl. drafts + refs
r = await call("GET", "/admin/content?published=true&type=audio", null, admin);
ok(r.status === 200 && r.json.items.some((c) => c.id === audioId && c.s3Key === "audio/seed-audio.mp3"), "admin list shows audio incl. s3Key");

// ── Member with tier 2 (Sculpt active) ──
const member = await mkMember("mem");
const sculptId = dbq(`SELECT id FROM programmes WHERE code='ashta_sculpt'`);
dbq(`INSERT INTO subscriptions (id,user_id,programme_id,status,current_period_start,current_period_end,auto_renew,created_at,updated_at) VALUES (gen_random_uuid(),'${member.userId}','${sculptId}','active',now(),now()+interval '30 days',true,now(),now())`);

r = await call("GET", "/content", null, member.access);
ok(r.status === 200 && r.json.items.some((c) => c.id === audioId), "member(t2) sees tier-2 audio");
ok(!r.json.items.some((c) => c.id === videoId), "member(t2) does NOT see tier-3 video (tier gate)");
ok(r.json.items.some((c) => c.id === freeVideoId), "member(t2) sees free video");
ok(!r.json.items.some((c) => c.s3Key || c.videoRef), "member list never leaks media refs");

r = await call("GET", `/content/${audioId}`, null, member.access);
ok(r.status === 200 && r.json.content.title === "Tier2 Audio", "member GET /content/:id (entitled)");
r = await call("GET", `/content/${videoId}`, null, member.access);
ok(r.status === 404, "member GET /content/:id above tier → 404 (RLS invisible)");

// Playback discrimination
r = await call("GET", `/content/${audioId}/playback`, null, member.access);
ok(r.status === 503 && r.json.error?.code === "s3_unconfigured", "entitled audio playback → reached S3 signer (503 unconfigured)");
r = await call("GET", `/content/${freeVideoId}/playback`, null, member.access);
ok(r.status === 503 && r.json.error?.code === "video_unconfigured", "entitled video playback → reached Mux signer (503 unconfigured)");
r = await call("GET", `/content/${videoId}/playback`, null, member.access);
ok(r.status === 403 && r.json.error?.code === "tier_gated", "above-tier playback → 403 tier_gated (not 404)");
r = await call("GET", `/content/${crypto.randomUUID()}/playback`, null, member.access);
ok(r.status === 404, "missing content playback → 404");

// Progress
r = await call("PUT", `/content/${audioId}/progress`, { positionSeconds: 30, status: "in_progress" }, member.access);
ok(r.status === 200 && r.json.contentProgress.positionSeconds === 30 && !r.json.contentProgress.completedAt, "PUT progress in_progress");
r = await call("PUT", `/content/${audioId}/progress`, { positionSeconds: 600, status: "completed" }, member.access);
ok(r.status === 200 && r.json.contentProgress.completedAt, "PUT progress completed sets completedAt (upsert)");
r = await call("PUT", `/content/${videoId}/progress`, { positionSeconds: 5, status: "in_progress" }, member.access);
ok(r.status === 404, "PUT progress on invisible content → 404 (can't log above tier)");
r = await call("GET", "/me/progress", null, member.access);
ok(r.status === 200 && r.json.items.some((p) => p.contentId === audioId && p.status === "completed"), "GET /me/progress shows own row");

// Progress entries
r = await call("POST", "/me/progress/entries", { entryDate: "2026-07-13", note: "felt calmer", metrics: { mood: 8 } }, member.access);
ok(r.status === 201 && r.json.progressEntry.metrics?.mood === 8, "POST /me/progress/entries");
r = await call("GET", "/me/progress/entries", null, member.access);
ok(r.status === 200 && r.json.items.length >= 1, "GET /me/progress/entries paginated");

// A tier-0 member (no subscription) is fully gated
const free = await mkMember("free");
r = await call("GET", "/content", null, free.access);
ok(!r.json.items.some((c) => c.id === audioId), "tier-0 member does NOT see tier-2 audio");
ok(r.json.items.some((c) => c.id === freeVideoId), "tier-0 member sees free (tier-0) content");

// Admin update + delete
r = await call("PATCH", `/admin/content/${audioId}`, { title: "Renamed" }, admin);
ok(r.status === 200 && r.json.content.title === "Renamed", "admin PATCH content");
r = await call("PATCH", `/admin/content/${audioId}`, { videoRef: "mux_sneaky" }, admin);
ok(r.status === 400 && r.json.error?.code === "invalid_request", "PATCH rejects adding videoRef to an audio row (XOR invariant)");
r = await call("DELETE", `/admin/content/${freeVideoId}`, null, admin);
ok(r.status === 200 && r.json.ok, "admin DELETE content");
r = await call("GET", `/content/${freeVideoId}`, null, member.access);
ok(r.status === 404, "deleted content gone");

// Cleanup created rows
dbq(`DELETE FROM content WHERE id IN ('${audioId}','${videoId}')`);
dbq(`DELETE FROM subscriptions WHERE user_id='${member.userId}'`);
dbq(`DELETE FROM users WHERE email LIKE 'm5%@example.com'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
