import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Router } from "express";
import express from "express";
import { env } from "./env";

// ── Local media driver (CR-007) — media stored & served by THIS Node server ──────────────
//
// A THIRD MEDIA_DRIVER, alongside "live" (S3/R2 + Cloudflare Stream) and "mock" (dev only).
// Uploads land on the server filesystem under MEDIA_ROOT; the API serves them back. It keeps
// the frozen contract §4 shapes — presign/playback still return { uploadUrl } / { url } — the
// URLs just point at us instead of S3/Stream. S3/R2/Stream stay in the tree as a config
// fallback (CR-007 Q3 = deprecate-but-retain).
//
// SECURITY MODEL — this REPLACES presigned S3 URLs, so unlike the mock it must actually sign:
//   * Every gated URL (upload PUT, member GET, avatar GET, video playback) carries an
//     HMAC-SHA256 signature over the object key + expiry (+ content-type/length on upload).
//     The serve/upload routes verify it and the expiry before touching disk — the tier check
//     happened UPSTREAM when the URL was minted (same as a presigned S3 GET), so the signed,
//     short-lived URL is the capability.
//   * Images (artwork) are NOT tier-gated, so they are served at a stable, cacheable public
//     path with no signature — the CDN's role.
//   * Path traversal is blocked by resolving under MEDIA_ROOT and confirming containment.
//
// 🔒 FLAGGED FOR HUMAN HARDENING (CLAUDE.md §5.6 — media/entitlement lane). First-draft crypto:
// the HMAC scheme, the range handling, and the disk layout must be human-reviewed and pass the
// Agent 7 gate before real traffic. Production also needs: a PERSISTENT, BACKED-UP MEDIA_ROOT
// volume (survives deploys), nginx client_max_body_size + ideally X-Accel-Redirect offload, and
// disk/bandwidth sizing revised upward (SERVER_SPECIFICATION.md — media is no longer off-box).

export const LOCAL_MEDIA_PREFIX = "/__media";

// Extension → content-type for serving (the inverse of media.ts CATEGORIES types, plus video).
const CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

// The only object-key shapes this driver will read or write — mirrors exactly what media.ts
// mints (`{prefix}/{uuid}.{ext}`, `avatars/{userId}/{uuid}.{ext}`, `video/{uuid}.{ext}`). Any
// other shape is rejected before it can reach disk, so a signed URL can never be steered at an
// arbitrary path even if the HMAC were somehow satisfied.
const KEY_RE =
  /^(audio|images|assets|avatars\/[0-9a-f-]{36}|video)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,4}$/;

export const localEnabled = (): boolean => env.MEDIA_DRIVER === "local";

function root(): string {
  return resolve(env.MEDIA_ROOT);
}

function signingKey(): string {
  // Dedicated key if provided, else reuse JWT_SECRET (already validated >=32 chars). A
  // separate MEDIA_SIGNING_KEY is preferable so rotating media URLs doesn't invalidate sessions.
  return env.MEDIA_SIGNING_KEY ?? env.JWT_SECRET;
}

// HMAC-SHA256 over the canonical, ordered parts. Any change to key/expiry/ct/len changes the
// digest, so an edited URL fails verification — the presigned-URL property, reproduced.
function sign(parts: string[]): string {
  return createHmac("sha256", signingKey()).update(parts.join("\n")).digest("hex");
}

function verifySig(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const expiryIso = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();
const base = (): string => env.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, "");

// ── URL builders (called by media.ts) ────────────────────────────────────────────────────

// Upload capability: a signed PUT to our upload route. content-type and length are baked into
// the signature exactly as a presigned S3 PUT bakes them, so the receiver rejects a body that
// contradicts either. `sizeBytes` may be 0/unknown (video) — then length is not pinned.
export function localUploadUrl(
  objectKey: string,
  contentType: string,
  sizeBytes: number,
  ttlSeconds: number,
): string {
  const exp = nowSec() + ttlSeconds;
  const len = sizeBytes > 0 ? String(sizeBytes) : "";
  const sig = sign(["PUT", objectKey, contentType, len, String(exp)]);
  const q = new URLSearchParams({ ct: contentType, len, exp: String(exp), sig });
  return `${base()}${LOCAL_MEDIA_PREFIX}/upload/${objectKey}?${q.toString()}`;
}

// Member/avatar serve capability: a short-lived signed GET. This is the presigned-GET analogue.
export function localSignedGetUrl(objectKey: string, ttlSeconds: number): string {
  const exp = nowSec() + ttlSeconds;
  const sig = sign(["GET", objectKey, String(exp)]);
  const q = new URLSearchParams({ exp: String(exp), sig });
  return `${base()}${LOCAL_MEDIA_PREFIX}/serve/${objectKey}?${q.toString()}`;
}

// Artwork: a stable, cacheable, UNSIGNED public URL (artwork is not tier-gated — same posture
// as the CDN path it replaces; the uuid filename gives free cache-busting on replacement).
export function localPublicUrl(objectKey: string): string {
  return `${base()}${LOCAL_MEDIA_PREFIX}/public/${objectKey}`;
}

// Best-effort delete (avatar replacement). Never throws — a stale file is tidiness, not
// correctness — mirroring deleteObject() in media.ts.
export async function localDeleteObject(objectKey: string): Promise<boolean> {
  if (!KEY_RE.test(objectKey)) return false;
  const p = safePath(objectKey);
  if (!p || !existsSync(p)) return false;
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(p);
    return true;
  } catch {
    return false;
  }
}

// ── Path safety ───────────────────────────────────────────────────────────────────────────
// Resolve under MEDIA_ROOT and confirm containment. The trailing separator matters: a bare
// startsWith(root) also accepts a SIBLING dir whose name merely starts with root's.
function safePath(key: string): string | null {
  const r = root();
  const full = resolve(r, normalize(key));
  return full === r || full.startsWith(r + sep) ? full : null;
}

function contentTypeFor(key: string): string {
  const ext = extname(key).slice(1).toLowerCase();
  return CONTENT_TYPE[ext] ?? "application/octet-stream";
}

// ── The router (mounted at LOCAL_MEDIA_PREFIX when MEDIA_DRIVER=local) ─────────────────────

// Express 5 returns a wildcard param as a path-segment array.
function wildcard(req: { params: unknown }): string {
  const k = (req.params as { key?: string | string[] }).key;
  return Array.isArray(k) ? k.join("/") : String(k ?? "");
}

export function localMediaRouter(): Router {
  const r = Router();
  mkdirSync(root(), { recursive: true });

  // Upload receiver — the local analogue of a presigned S3 PUT. Raw binary body; capped at the
  // audio category's 500 MB ceiling (media.ts). Verifies the signature + expiry + (content-type,
  // length) before writing, so an edited/expired URL cannot store anything.
  const raw = express.raw({ type: "*/*", limit: "500mb" });
  r.put("/upload/*key", raw, async (req, res) => {
    const key = wildcard(req);
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ error: { code: "invalid_key", message: "Bad object key" } });
    }
    const ct = String(req.query.ct ?? "");
    const len = String(req.query.len ?? "");
    const exp = Number(req.query.exp ?? NaN);
    const providedSig = String(req.query.sig ?? "");
    if (!Number.isFinite(exp) || !providedSig) {
      return res.status(403).json({ error: { code: "signature_invalid", message: "Missing/expired signature" } });
    }
    if (!verifySig(sign(["PUT", key, ct, len, String(exp)]), providedSig)) {
      return res.status(403).json({ error: { code: "signature_invalid", message: "Signature mismatch" } });
    }
    if (exp < nowSec()) {
      return res.status(403).json({ error: { code: "url_expired", message: "Upload URL expired" } });
    }
    const body = (req.body ?? Buffer.alloc(0)) as Buffer;
    const actualCt = String(req.headers["content-type"] ?? "").trim();
    if (ct && actualCt !== ct) {
      return res.status(403).json({ error: { code: "content_type_mismatch", message: `content-type ${actualCt || "(none)"} != signed ${ct}` } });
    }
    if (len && body.length !== Number(len)) {
      return res.status(403).json({ error: { code: "length_mismatch", message: `length ${body.length} != signed ${len}` } });
    }
    const p = safePath(key);
    if (!p) return res.status(400).json({ error: { code: "invalid_key", message: "Bad object key" } });
    mkdirSync(dirname(p), { recursive: true });
    await writeFile(p, body);
    return res.status(200).json({ ok: true, key, bytes: body.length });
  });

  // Gated serve — signed GET for audio / avatars / video playback. Verifies signature + expiry,
  // then streams with HTTP range support (seeking in audio/video).
  r.get("/serve/*key", (req, res) => {
    const key = wildcard(req);
    const exp = Number(req.query.exp ?? NaN);
    const providedSig = String(req.query.sig ?? "");
    if (!KEY_RE.test(key) || !Number.isFinite(exp) || !providedSig) {
      return res.status(403).json({ error: { code: "signature_invalid", message: "Missing signature" } });
    }
    if (!verifySig(sign(["GET", key, String(exp)]), providedSig)) {
      return res.status(403).json({ error: { code: "signature_invalid", message: "Signature mismatch" } });
    }
    if (exp < nowSec()) {
      return res.status(403).json({ error: { code: "url_expired", message: "URL expired" } });
    }
    return streamFile(key, req, res, "private, max-age=0, no-store");
  });

  // Public serve — artwork only (images/), unsigned, cacheable. The prefix guard means a signed
  // audio/video key can never be fetched here without a signature.
  r.get("/public/*key", (req, res) => {
    const key = wildcard(req);
    if (!key.startsWith("images/") || !KEY_RE.test(key)) {
      return res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    }
    return streamFile(key, req, res, "public, max-age=31536000, immutable");
  });

  return r;
}

// Stream a file from disk with single-range support and the right content-type + cache header.
function streamFile(
  key: string,
  req: express.Request,
  res: express.Response,
  cacheControl: string,
): express.Response | void {
  const p = safePath(key);
  if (!p || !existsSync(p)) {
    return res.status(404).json({ error: { code: "not_found", message: "Media not found" } });
  }
  const size = statSync(p).size;
  const type = contentTypeFor(key);
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range) {
    // Single "bytes=start-end" range — enough for seeking; multipart ranges are not supported.
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      return void createReadStream(p, { start, end }).pipe(res);
    }
  }
  res.setHeader("Content-Length", String(size));
  return void createReadStream(p).pipe(res);
}
