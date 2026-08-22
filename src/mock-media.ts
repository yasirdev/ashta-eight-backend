import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { Router } from "express";
import express from "express";
import { env } from "./env";

// Mock media origin — LOCAL DEVELOPMENT AND QA ONLY.
//
// Stands in for S3 (object PUT/GET) and Cloudflare Stream (upload + playback) so the whole
// media contract round-trips with NO cloud account. That unblocks Agent 2 and QA from the
// credentials wait: the admin can "upload", the member can "play", and every request/
// response shape is the real one.
//
// WHAT IT PROVES: the flow, the shapes, tier gating (the tier check happens upstream in the
// route, not here), and that the client wiring is correct.
// WHAT IT DOES NOT PROVE: real ABR transcoding, real signature verification, real CORS, or
// real provider errors. Those stay untested until credentials land — see TEST_REPORT §4.
//
// SECURITY: this router serves bytes with NO authentication — the "token" query param is
// decorative. Reachable outside dev/test it would serve every member's media to anyone with
// a URL and bypass every tier check in the system.
// It is gated by `mockMediaAllowed()` (media.ts): MEDIA_DRIVER must be "mock" AND NODE_ENV
// must be an explicitly allow-listed non-prod env. Both are enums, so an unrecognised value
// fails at boot rather than defaulting open.
// An earlier comment here claimed "two independent guards". That was FALSE: both compared
// NODE_ENV to the same literal, so `NODE_ENV=Production` defeated both at once and served
// unauthenticated media. The real protection is MEDIA_DRIVER's enum + its "live" default.

const ROOT = join(tmpdir(), "ashta-mock-media");

// Path traversal guard: an object key comes from the URL, so "../../etc/passwd" must not
// escape ROOT. Resolve and confirm containment rather than trusting the key.
// The trailing separator matters: a bare `startsWith(ROOT)` also accepts a SIBLING whose
// name merely starts with ROOT's — `../ashta-mock-media-evil/pwn` escaped past it.
function safePath(key: string): string | null {
  const root = resolve(ROOT);
  const full = resolve(root, normalize(key));
  return full === root || full.startsWith(root + sep) ? full : null;
}

export function mockMediaRouter(): Router {
  const r = Router();
  mkdirSync(ROOT, { recursive: true });

  // Accept any binary body — this stands in for a presigned S3 PUT / Stream upload.
  // 500mb = the audio category's real cap (media.ts CATEGORIES). Was 600mb — an
  // arbitrary number above every real limit, buffering the whole body in memory. Dev-only,
  // but there is no reason for the mock to accept what presign would have rejected.
  const raw = express.raw({ type: "*/*", limit: "500mb" });

  // S3 stand-in: PUT an object, GET it back.
  // Express 5 gives a wildcard param as a path-segment ARRAY, not a string.
  const wildcard = (req: { params: unknown }): string => {
    const k = (req.params as { key?: string | string[] }).key;
    return Array.isArray(k) ? k.join("/") : String(k ?? "");
  };

  r.put("/object/*key", raw, async (req, res) => {
    const key = wildcard(req);
    const p = safePath(key);
    if (!p) return res.status(400).json({ error: { code: "invalid_key", message: "Bad object key" } });

    // Enforce what the presign SIGNED. A real presigned S3 PUT bakes ContentType and
    // ContentLength into the SigV4 signature, so S3 403s a PUT that contradicts either.
    // The mock must do the same or it is laxer than production — which manufactures a
    // green run that turns red the day credentials land. 403 mirrors S3's status.
    const body = (req.body ?? Buffer.alloc(0)) as Buffer;
    const declaredCt = String(req.query.mock_ct ?? "");
    const declaredLen = Number(req.query.mock_len ?? NaN);

    // FAIL CLOSED on missing params. presignUpload ALWAYS emits both, so their absence
    // means the URL was edited — and on real S3, editing any signed param invalidates the
    // signature outright. The earlier `if (declaredCt && ...)` / `if (isFinite(...))` form
    // skipped the check instead: stripping `mock_len` let 5000 bytes through a signature
    // for 11. Guarding "only if present" is how a check becomes optional to an attacker.
    if (!declaredCt || !Number.isFinite(declaredLen)) {
      return res.status(403).json({
        error: {
          code: "signature_mismatch",
          message: "presign parameters missing or malformed — a signed URL cannot be edited",
        },
      });
    }
    // EXACT match, deliberately — not `split(";")[0]`. S3 signs the ContentType verbatim, so
    // `audio/mpeg; charset=utf-8` against a signature for `audio/mpeg` is a 403 there. The
    // mock mirrors that: stricter than prod is safe, laxer is what caused MAJOR-2.
    const actualCt = String(req.headers["content-type"] ?? "").trim();
    if (actualCt !== declaredCt) {
      return res.status(403).json({
        error: { code: "signature_mismatch", message: `content-type ${actualCt || "(none)"} != signed ${declaredCt}` },
      });
    }
    if (body.length !== declaredLen) {
      return res.status(403).json({
        error: { code: "signature_mismatch", message: `length ${body.length} != signed ${declaredLen}` },
      });
    }

    mkdirSync(dirname(p), { recursive: true });
    await writeFile(p, body);
    res.status(200).json({ ok: true, key, bytes: body.length });
  });

  r.get("/object/*key", (req, res) => {
    const key = wildcard(req);
    const p = safePath(key);
    if (!p || !existsSync(p)) {
      return res.status(404).json({ error: { code: "not_found", message: "Mock object not found" } });
    }
    createReadStream(p).pipe(res);
  });

  // Cloudflare Stream stand-in: POST the master file, then a signed-ish manifest URL.
  r.post("/upload/:uid", raw, async (req, res) => {
    const p = safePath(join("video", String(req.params.uid)));
    if (!p) return res.status(400).json({ error: { code: "invalid_key", message: "Bad uid" } });
    mkdirSync(dirname(p), { recursive: true });
    await writeFile(p, req.body as Buffer);
    res.status(200).json({ ok: true, uid: req.params.uid });
  });

  // Playback stand-in. A real provider returns an ABR HLS manifest; the mock returns a
  // minimal valid .m3u8 so a player gets the right content-type and shape rather than a
  // 404. It is NOT adaptive — mock playback proves wiring, not ABR.
  r.get("/playback/:uid/manifest/video.m3u8", (req, res) => {
    const p = safePath(join("video", String(req.params.uid)));
    res.type("application/vnd.apple.mpegurl").send(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:10",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXTINF:10.0,",
        `${env.MOCK_MEDIA_BASE_URL}/__mock-media/object/video/${req.params.uid}`,
        "#EXT-X-ENDLIST",
        `## mock manifest — source present: ${p && existsSync(p)}`,
      ].join("\n"),
    );
  });

  return r;
}
