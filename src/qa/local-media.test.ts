// CR-007 — local media driver round-trip + security guards. DB-free: it mounts only the
// local media router (no createApp/Postgres). Run: `npx tsx src/qa/local-media.test.ts`.
//
// Env MUST be set before importing env.ts (it parses process.env at import time).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4599;
process.env.NODE_ENV = "test";
process.env.MEDIA_DRIVER = "local";
process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), "ashta-local-media-"));
process.env.MEDIA_PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.MEDIA_SIGNING_KEY = "test-media-signing-key-of-at-least-32-chars";
// Required by env.ts (no DB is actually contacted by these modules).
process.env.DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.APP_DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.SERVICE_DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.JWT_SECRET ??= "test-jwt-secret-of-at-least-32-characters-long";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message.split("\n")[0] });
  }
}

async function main() {
  const express = (await import("express")).default;
  const { LOCAL_MEDIA_PREFIX, localMediaRouter } = await import("../local-media");
  const { presignUpload, presignDownload, thumbnailUrl, createVideoUpload, signPlayback } =
    await import("../media");

  const app = express();
  app.use(LOCAL_MEDIA_PREFIX, localMediaRouter());
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(PORT, () => resolve(s));
  });

  const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(40), "hex"); // tiny fake PNG bytes
  const mp3 = Buffer.from("49443303" + "11".repeat(200), "hex"); // fake audio bytes

  // 1. Image upload → public (unsigned, cacheable) serve.
  await check("image upload → public serve round-trips", async () => {
    const { uploadUrl, objectKey } = await presignUpload("image", "image/png", png.length);
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: png });
    assert.equal(put.status, 200, `upload status ${put.status}`);
    const url = await thumbnailUrl(objectKey);
    assert.ok(url && url.includes("/public/images/"), "thumbnail is a public URL");
    const get = await fetch(url!);
    assert.equal(get.status, 200, `serve status ${get.status}`);
    assert.match(get.headers.get("cache-control") ?? "", /public/);
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(bytes.length, png.length, "served bytes match uploaded");
  });

  // 2. Audio upload → short-lived signed GET.
  let audioKey = "";
  await check("audio upload → signed GET serves bytes", async () => {
    const up = await presignUpload("audio", "audio/mpeg", mp3.length);
    audioKey = up.objectKey;
    const put = await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: mp3 });
    assert.equal(put.status, 200, `upload status ${put.status}`);
    const { url } = await presignDownload(audioKey);
    assert.ok(url.includes("/serve/") && url.includes("sig="), "signed serve URL");
    const get = await fetch(url);
    assert.equal(get.status, 200, `serve status ${get.status}`);
    assert.equal(get.headers.get("accept-ranges"), "bytes");
    assert.match(get.headers.get("cache-control") ?? "", /no-store/);
  });

  // 3. Range request → 206 partial content.
  await check("range request returns 206 partial", async () => {
    const { url } = await presignDownload(audioKey);
    const get = await fetch(url, { headers: { range: "bytes=0-9" } });
    assert.equal(get.status, 206, `range status ${get.status}`);
    assert.equal(get.headers.get("content-length"), "10");
    assert.match(get.headers.get("content-range") ?? "", /^bytes 0-9\//);
  });

  // 4. Tampered signature → 403.
  await check("tampered signature is rejected", async () => {
    const { url } = await presignDownload(audioKey);
    const bad = url.replace(/sig=([0-9a-f]+)/, (_m, s) => "sig=" + (s[0] === "0" ? "1" : "0") + s.slice(1));
    const get = await fetch(bad);
    assert.equal(get.status, 403, `expected 403, got ${get.status}`);
  });

  // 5. Upload with wrong content-type → 403 (signature pins it).
  await check("content-type mismatch on upload is rejected", async () => {
    const { uploadUrl } = await presignUpload("image", "image/png", png.length);
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: png });
    assert.equal(put.status, 403, `expected 403, got ${put.status}`);
  });

  // 6. Path traversal / bad key → rejected (never 200).
  await check("path traversal key is rejected", async () => {
    const get = await fetch(`http://127.0.0.1:${PORT}${LOCAL_MEDIA_PREFIX}/public/images/..%2f..%2fetc%2fpasswd`);
    assert.ok(get.status === 404 || get.status === 400, `expected 404/400, got ${get.status}`);
  });

  // 7. Gated audio key cannot be fetched via the UNSIGNED public route.
  await check("gated audio not served on public route", async () => {
    const get = await fetch(`http://127.0.0.1:${PORT}${LOCAL_MEDIA_PREFIX}/public/${audioKey}`);
    assert.equal(get.status, 404, `expected 404, got ${get.status}`);
  });

  // 8. Video: createVideoUpload → PUT → signed playback GET.
  await check("video upload → signed playback round-trips", async () => {
    const { uploadUrl, provider, pendingRef } = await createVideoUpload("lesson.mp4");
    assert.equal(provider, "local_server");
    const mp4 = Buffer.from("00000018667479706d70343200" + "22".repeat(100), "hex");
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "video/mp4" }, body: mp4 });
    assert.equal(put.status, 200, `upload status ${put.status}`);
    const { url } = signPlayback(pendingRef);
    const get = await fetch(url);
    assert.equal(get.status, 200, `playback status ${get.status}`);
    assert.equal(get.headers.get("content-type"), "video/mp4");
  });

  server.close();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main();
