import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { AppError } from "./http";
import { mockEnabled, mockOkEnv } from "./mocking";
import {
  localDeleteObject,
  localEnabled,
  localPublicUrl,
  localSignedGetUrl,
  localUploadUrl,
} from "./local-media";

// Media signing (Module 5). Two providers, both first-draft + FLAGGED FOR HUMAN
// HARDENING (contract §4 / agent-1-backend.md S3 flow):
//   - S3-compatible object storage for audio/images/assets/avatars: presigned PUT (admin
//     upload) + presigned GET (member serve). Bucket is private; access ONLY via these
//     short-lived URLs. Provider = AWS S3 OR Cloudflare R2 (CR-005, authorized 2026-07-28):
//     R2 is S3-compatible, so the SAME presign code drives both — R2 is selected by config
//     (S3_ENDPOINT) with no shape change. See s3Client() below.
//   - Cloudflare Stream for video: RS256-signed playback JWT (stream-only, ABR) + direct
//     upload. UNCHANGED by CR-005 — video stays on Stream (CR-005 Q1=a) to keep ABR + no-download.
// Each function 503s when its keys aren't configured, so the app boots and all
// non-media flows work locally (same pattern as stripe.ts).

// ── S3-compatible storage: AWS S3 or Cloudflare R2 (audio / images / assets / avatars) ──

// Per-category rules: key prefix (enforced), allowed MIME types → extension.
// Prefixes let the IAM policy / bucket lifecycle scope by category (agent prompt).
const MB = 1024 * 1024;
const CATEGORIES = {
  audio: {
    prefix: "audio",
    maxBytes: 500 * MB,
    types: { "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav" },
  },
  image: {
    prefix: "images",
    maxBytes: 15 * MB,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
  asset: {
    prefix: "assets",
    maxBytes: 25 * MB,
    types: { "application/pdf": "pdf", "application/json": "json" },
  },
  // Member avatars (G-8 / ARCH_SPEC_G4_G8 §5). A FIFTH category with NO client choice in
  // it: the member presign hardcodes `category = "avatar"` and never reads it from the
  // request, so a member can never mint a signed PUT into `audio/`/`assets/` (the paid
  // namespace) the way opening the admin presign's enum to them would. One-tenth the
  // admin image cap; images only.
  avatar: {
    prefix: "avatars",
    maxBytes: 5 * MB,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
} as const;

export type UploadCategory = keyof typeof CATEGORIES;

let s3: S3Client | undefined;
function s3Client(): S3Client {
  if (!env.S3_BUCKET || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new AppError(503, "s3_unconfigured", "Object storage is not configured");
  }
  // Provider = AWS S3 OR Cloudflare R2 (CR-005). R2 is S3-compatible, so it is the SAME client:
  // setting S3_ENDPOINT points it at `https://<account>.r2.cloudflarestorage.com` (region "auto",
  // path-style addressing). Unset ⇒ AWS S3 via the SDK's default regional endpoint — a config-only
  // rollback (CR-005 Q3). Presigned PUT/GET (SigV4) are byte-compatible across both, so every
  // presign call below is unchanged.
  s3 ??= new S3Client({
    region: env.AWS_REGION,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  return s3;
}

// Admin upload: mint a 5-min presigned PUT to `{prefix}/{uuid}.{ext}`. The
// content-type is baked into the signature, so S3 rejects a PUT whose header
// doesn't match — that's the type enforcement. Returns the final object key the
// admin then saves via POST /admin/content.
export async function presignUpload(
  category: UploadCategory,
  contentType: string,
  sizeBytes: number,
): Promise<{ uploadUrl: string; objectKey: string; expiresAt: string }> {
  const cat = CATEGORIES[category];
  if (!cat) throw new AppError(400, "invalid_category", "Unknown upload category");
  const ext = (cat.types as Record<string, string>)[contentType];
  if (!ext) {
    throw new AppError(400, "unsupported_type", `Content-type ${contentType} not allowed for ${category}`);
  }
  if (sizeBytes <= 0 || sizeBytes > cat.maxBytes) {
    throw new AppError(400, "size_exceeded", `${category} upload must be 1..${cat.maxBytes} bytes`);
  }
  const objectKey = `${cat.prefix}/${randomUUID()}.${ext}`;
  // Mock: same validation above still runs (category, type, size are the contract), only
  // the signing is faked — so a client that passes here passes against real S3 too.
  if (mock()) {
    // Carry the DECLARED content-type and length so the mock can reject a PUT that
    // contradicts them — exactly as S3 does, because both are baked into the SigV4
    // signature below. Without this the mock is LAXER than production: a client could
    // declare 11 bytes of audio/mpeg and upload 5MB of anything, pass locally, and fail
    // the day real credentials land. A mock may be stricter than prod; never laxer.
    return {
      uploadUrl: mockUrl(
        `object/${objectKey}?mock_ct=${encodeURIComponent(contentType)}&mock_len=${sizeBytes}`,
      ),
      objectKey,
      expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS),
    };
  }
  // Local driver (CR-007): a signed PUT to our own upload route, same validated key/type/size.
  if (localEnabled()) {
    return {
      uploadUrl: localUploadUrl(objectKey, contentType, sizeBytes, env.S3_UPLOAD_TTL_SECONDS),
      objectKey,
      expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS),
    };
  }
  // Size enforcement: sizeBytes is checked against the per-category cap AND baked into
  // the signature as ContentLength, so S3 rejects any PUT whose actual length differs
  // from what was declared (a SigV4 PUT can't sign a *range*, so the client must
  // declare its size — File.size in the browser). content-type is likewise pinned.
  // ponytail: exact-length pin, not a range — needs the true byte count up front.
  const uploadUrl = await getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: sizeBytes,
    }),
    { expiresIn: env.S3_UPLOAD_TTL_SECONDS },
  );
  return { uploadUrl, objectKey, expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS) };
}

// Member serve: short-lived presigned GET for an audio object (after the tier
// check upstream has already passed).
export async function presignDownload(objectKey: string): Promise<{ url: string; expiresAt: string }> {
  if (mock()) {
    return {
      url: mockUrl(`object/${objectKey}?mock_token=${randomUUID()}`),
      expiresAt: expiry(env.S3_DOWNLOAD_TTL_SECONDS),
    };
  }
  // Local driver (CR-007): short-lived signed GET to our serve route — the presigned-GET analogue.
  if (localEnabled()) {
    return {
      url: localSignedGetUrl(objectKey, env.S3_DOWNLOAD_TTL_SECONDS),
      expiresAt: expiry(env.S3_DOWNLOAD_TTL_SECONDS),
    };
  }
  const url = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }),
    { expiresIn: env.S3_DOWNLOAD_TTL_SECONDS },
  );
  return { url, expiresAt: expiry(env.S3_DOWNLOAD_TTL_SECONDS) };
}

// ── Member avatar (G-8 / ARCH_SPEC_G4_G8 §5) ─────────────────────────────────
// A member-only presign whose category is FIXED server-side to `avatar`. The object key
// is namespaced under the caller's OWN id — `avatars/{userId}/{uuid}.{ext}` — so keys are
// non-enumerable across members and the PATCH /me guard can pin them to the caller.
//
// `sizeBytes` is OPTIONAL here (the contract's request shape is `{contentType}`): when the
// client supplies it (Agent 2 re-encodes to strip EXIF, so it knows the size), it is
// checked against the 5 MB cap AND baked into the signature as ContentLength exactly like
// the admin path; when omitted, the content-type pin + the 5 MB-capped `avatar` category +
// the presign rate limit are the backstops. Requiring it (as the admin presign does) would
// be stronger — flagged for the human, kept contract-compatible here.
export async function presignAvatarUpload(
  userId: string,
  contentType: string,
  sizeBytes?: number,
): Promise<{ uploadUrl: string; objectKey: string; expiresAt: string }> {
  const cat = CATEGORIES.avatar;
  const ext = (cat.types as Record<string, string>)[contentType];
  if (!ext) {
    throw new AppError(400, "unsupported_type", `Content-type ${contentType} not allowed for avatar`);
  }
  if (sizeBytes !== undefined && (sizeBytes <= 0 || sizeBytes > cat.maxBytes)) {
    throw new AppError(400, "size_exceeded", `avatar upload must be 1..${cat.maxBytes} bytes`);
  }
  const objectKey = `${cat.prefix}/${userId}/${randomUUID()}.${ext}`;
  if (mock()) {
    // Mirror presignUpload's mock: carry the declared type (+ length when known) so the
    // mock is never LAXER than real S3.
    const lenParam = sizeBytes !== undefined ? `&mock_len=${sizeBytes}` : "";
    return {
      uploadUrl: mockUrl(`object/${objectKey}?mock_ct=${encodeURIComponent(contentType)}${lenParam}`),
      objectKey,
      expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS),
    };
  }
  // Local driver (CR-007): signed PUT to our upload route; length pinned only when supplied.
  if (localEnabled()) {
    return {
      uploadUrl: localUploadUrl(objectKey, contentType, sizeBytes ?? 0, env.S3_UPLOAD_TTL_SECONDS),
      objectKey,
      expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS),
    };
  }
  const uploadUrl = await getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      ...(sizeBytes !== undefined ? { ContentLength: sizeBytes } : {}),
    }),
    { expiresIn: env.S3_UPLOAD_TTL_SECONDS },
  );
  return { uploadUrl, objectKey, expiresAt: expiry(env.S3_UPLOAD_TTL_SECONDS) };
}

// Best-effort delete of a previous avatar object when a member replaces theirs (§5.2) —
// orphaned objects are personal data nobody can find. Never throws: a failed cleanup must
// not fail the PATCH that already succeeded. No-op under the mock driver (nothing to
// delete) and when S3 is unconfigured. Returns true on a real delete, false otherwise.
export async function deleteObject(objectKey: string | null): Promise<boolean> {
  if (!objectKey || mock()) return false;
  if (localEnabled()) return localDeleteObject(objectKey);
  try {
    await s3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
    return true;
  } catch {
    return false; // logged by the caller; a stale object is tidiness, not correctness
  }
}

// The ONLY key shape `PATCH /me {avatarObjectKey}` accepts, pinned to the caller's OWN id.
// This regex is the guard (§5.4) between a member and a pointer into the tier-gated
// `audio/` namespace: the key must live under exactly `avatars/<thisUser>/`, with a uuid
// filename and an image extension — precisely what presignAvatarUpload mints.
export function avatarObjectKeyRe(userId: string): RegExp {
  // userId is a server-derived UUID (auth), so it contains only hex + hyphens — safe to
  // embed literally. Anchored, so `avatars/<id>/../audio/x.mp3` and any other prefix fail.
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(`^avatars/${userId}/${uuid}\\.(jpg|png|webp)$`);
}

// Resolve a stored avatar key to a SHORT-LIVED presigned GET — deliberately NOT the CDN
// path artwork uses (§5.1): an avatar is personal data and must not sit at a permanent,
// enumerable, cache-persisting public URL. Fail-SOFT to null: serializeUser runs on the
// login/`/me` responses, and an unconfigured/failing S3 must never break authentication —
// a null avatar degrades to the client's initial fallback.
export async function avatarUrl(objectKey: string | null): Promise<string | null> {
  if (!objectKey) return null;
  try {
    return (await presignDownload(objectKey)).url;
  } catch {
    return null; // S3 unconfigured/unavailable — never fail the auth response over an avatar
  }
}

// ── Content artwork (G-7) ────────────────────────────────────────────────────
// Artwork is NOT tier-gated — it appears on cards for content the member has not
// bought; that is the point of a paywall card. So the serving decision is purely
// operational, and a stable CDN URL wins over presigning: a presigned GET mints a
// fresh URL on every refresh, which breaks device caching outright.
//
// 🔒 The bucket that holds artwork ALSO holds tier-gated audio under `audio/`, so a
// free-text object key on an admin endpoint is a path to publishing paid audio at a
// permanent, unauthenticated CDN URL. TWO independent guards, because the failure mode
// is *permanently publishing paid content*:
//   1. This regex, pinned to EXACTLY the key shape presignUpload('image', …) mints —
//      the API never stores a key it did not itself issue the shape for.
//   2. CloudFront/OAC restricted to `images/*` (Agent 6, infra). Independent of the API:
//      even a stored bad key cannot resolve to an audio object through the distribution.
export const IMAGE_OBJECT_KEY_RE =
  /^images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

let warnedNoCdn = false;

// Resolve a stored thumbnail key to an ABSOLUTE url for the client (never the raw key
// — same posture as s3Key/videoRef, which the member serializer withholds).
//   key set + MEDIA_CDN_BASE_URL set → stable CDN url (cacheable forever; the uuid
//                                      filename gives free cache-busting on replacement)
//   key set + no CDN                 → presigned GET, so dev works and the shape never varies
//   anything unresolvable            → null, NEVER "" and never a bare key
//
// Deliberately fail-SOFT to null: this runs inside `GET /content`, and letting an
// unconfigured/failing S3 throw would 503 the whole catalogue over a decorative image.
export async function thumbnailUrl(objectKey: string | null): Promise<string | null> {
  if (!objectKey) return null;
  // Local driver (CR-007): stable, cacheable, unsigned public URL — the CDN's role (artwork
  // is not tier-gated). The uuid filename gives free cache-busting on replacement.
  if (localEnabled()) return localPublicUrl(objectKey);
  if (env.MEDIA_CDN_BASE_URL) {
    return `${env.MEDIA_CDN_BASE_URL.replace(/\/+$/, "")}/${objectKey}`;
  }
  if (!warnedNoCdn) {
    warnedNoCdn = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[media] MEDIA_CDN_BASE_URL is unset — thumbnails are served as EXPIRING presigned " +
        "URLs. Correct for dev; in production it silently defeats device caching.",
    );
  }
  try {
    return (await presignDownload(objectKey)).url;
  } catch {
    return null; // S3 unconfigured/unavailable — a missing image must not break the list
  }
}

// ── Video (Cloudflare Stream) ────────────────────────────────────────────────
// DECISION (logged 2026-07-17, human): provider = Cloudflare Stream, swapped from Mux.
// contracts.md §4 and CLAUDE.md §2 both permit "Mux OR Cloudflare Stream", so this is a
// choice between two pre-approved options — NOT a contract change. Signing stays isolated
// here; the DB seam (`content.video_ref` = "provider playback id") is unchanged, so no
// migration and no API-shape change. Cloudflare gives the same R1 guarantees as Mux:
// ABR (it transcodes to renditions) + short-lived signed playback (stream-only).
//
// NOTE (true for ANY provider): "no download" is signed-URL deterrence, not DRM. A
// determined viewer can still capture HLS segments. Real no-download needs
// FairPlay/Widevine and is a separate, larger piece of work — flagged for the human.

// Signed playback URL. Cloudflare Stream verifies an RS256 JWT whose `sub` is the video
// uid; the token replaces the uid in the path. Same shape as the Mux flow it replaces.
export function signPlayback(playbackId: string): { url: string; expiresAt: string } {
  if (mock()) return mockPlayback(playbackId);
  // Local driver (CR-007, video MUST waived): the video is a file we host; return a short-lived
  // signed GET (range-enabled) instead of a Cloudflare Stream ABR manifest. `playbackId` is the
  // stored object key (`video/{uuid}.{ext}`). Single-bitrate, downloadable — per the waiver.
  if (localEnabled()) {
    return {
      url: localSignedGetUrl(playbackId, env.PLAYBACK_TTL_SECONDS),
      expiresAt: expiry(env.PLAYBACK_TTL_SECONDS),
    };
  }
  if (!env.CF_STREAM_KEY_ID || !env.CF_STREAM_KEY_PEM || !env.CF_STREAM_CUSTOMER_CODE) {
    throw new AppError(503, "video_unconfigured", "Video provider is not configured");
  }
  const privateKey = Buffer.from(env.CF_STREAM_KEY_PEM, "base64").toString("utf8");
  const token = jwt.sign({ sub: playbackId, kid: env.CF_STREAM_KEY_ID }, privateKey, {
    algorithm: "RS256",
    keyid: env.CF_STREAM_KEY_ID,
    expiresIn: env.PLAYBACK_TTL_SECONDS,
  });
  return {
    url: `https://customer-${env.CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/manifest/video.m3u8`,
    expiresAt: expiry(env.PLAYBACK_TTL_SECONDS),
  };
}

// Admin video upload: create a Cloudflare Stream direct upload. The admin browser POSTs
// the master file straight to the returned one-time URL; Cloudflare transcodes to ABR and
// the uid (`pendingRef`) becomes `content.video_ref`.
// `requireSignedURLs: true` is the load-bearing flag — without it the video is publicly
// playable by uid and every tier check in this system is bypassable by sharing a link.
export async function createVideoUpload(
  filename: string,
): Promise<{ uploadUrl: string; provider: string; pendingRef: string }> {
  if (mock()) return mockVideoUpload(filename);
  // Local driver (CR-007, video MUST waived): mint a signed PUT to our upload route. The object
  // key becomes content.video_ref; length isn't known up front (0 = unpinned), content-type is
  // derived from the filename extension. Admin PUTs the master file straight to this URL.
  if (localEnabled()) {
    const ext = (filename.split(".").pop() ?? "").toLowerCase();
    const allowed: Record<string, true> = { mp4: true, mov: true, webm: true };
    const objectKey = `video/${randomUUID()}.${allowed[ext] ? ext : "mp4"}`;
    // Content-type is NOT pinned for video: the admin video PUT (content-form.tsx) sends the
    // file without an explicit content-type header, and browsers set it inconsistently for a
    // File body. The key's extension allowlist + the signature over key+expiry are the guard.
    return {
      uploadUrl: localUploadUrl(objectKey, "", 0, env.S3_UPLOAD_TTL_SECONDS),
      provider: "local_server",
      pendingRef: objectKey,
    };
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new AppError(503, "video_unconfigured", "Video provider is not configured");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/direct_upload`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        maxDurationSeconds: 7200,
        requireSignedURLs: true, // stream-only; see above — the actual access control
        meta: { name: filename },
        // NO allowedOrigins. It restricts the domains a video may be PLAYED/embedded on —
        // not who may upload — so scoping it to the admin origin (as the Mux `cors_origin`
        // it replaced did) would let the admin panel play a video and block the member app
        // from playing anything. Access is enforced by requireSignedURLs + the tier check
        // upstream; adding an origin pin here would break playback, not harden it.
      }),
    },
  );
  if (!res.ok) {
    throw new AppError(502, "video_provider_error", `Cloudflare Stream upload create failed (${res.status})`);
  }
  const body = (await res.json()) as { success: boolean; result: { uploadURL: string; uid: string } };
  if (!body.success || !body.result?.uid) {
    throw new AppError(502, "video_provider_error", "Cloudflare Stream returned no upload");
  }
  return { uploadUrl: body.result.uploadURL, provider: "cloudflare_stream", pendingRef: body.result.uid };
}

// ── Mock driver (local development + QA only) ────────────────────────────────
// Lets the whole media contract round-trip with NO AWS/Cloudflare account, so Agent 2 and
// QA are not blocked on credentials. It proves the SHAPES and the flow — it does NOT
// prove the provider's behaviour (real ABR, real signature verification, real CORS).
// Those stay untested until credentials land; see TEST_REPORT §4.
// The mock gate now lives in mocking.ts — one predicate shared by media, Zoom and FCM.
// It used to live here, and server.ts re-implemented it; that duplication was MAJOR-1.
function mock(): boolean {
  return mockEnabled(env.MEDIA_DRIVER);
}

// Single source of truth for "may the mock origin be mounted" — server.ts imports this
// rather than re-deriving it.
export const mockMediaAllowed = (): boolean => env.MEDIA_DRIVER === "mock" && mockOkEnv();

const mockUrl = (path: string) => `${env.MOCK_MEDIA_BASE_URL}${MOCK_PREFIX}${path}`;
export const MOCK_PREFIX = "/__mock-media/";

function mockPlayback(playbackId: string): { url: string; expiresAt: string } {
  // Mirrors the real shape: a token in the path, an .m3u8 at the end.
  return {
    url: mockUrl(`playback/${playbackId}/manifest/video.m3u8?mock_token=${randomUUID()}`),
    expiresAt: expiry(env.PLAYBACK_TTL_SECONDS),
  };
}

function mockVideoUpload(filename: string): { uploadUrl: string; provider: string; pendingRef: string } {
  const uid = randomUUID().replace(/-/g, "");
  return { uploadUrl: mockUrl(`upload/${uid}?name=${encodeURIComponent(filename)}`), provider: "mock", pendingRef: uid };
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
