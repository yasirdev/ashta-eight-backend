import { config } from "dotenv";
import { z } from "zod";

config();

// Fail fast at boot if a required secret is missing. OAuth client ids are
// optional so the app boots for local email/password testing without them;
// the relevant endpoints 503 if called while unconfigured (see oauth.ts).
// ALLOW-list of environments where a *_DRIVER=mock is permitted. An unknown environment
// must refuse, not default open: a mock serves unauthenticated data.
export const MOCK_OK_ENVS = new Set<string>(["development", "test"]);

const schema = z.object({
  // Enum, not z.string(): this value gates whether the unauthenticated mock media origin
  // may run, so an unrecognised value must fail LOUDLY at boot rather than be silently
  // treated as "not production". `NODE_ENV=Production` previously mounted the mock in a
  // production deploy — a capital letter defeated the guard.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // TEST-ONLY ESCAPE HATCH. When true, every password-reset code is the fixed
  // value below instead of a random one, so the reset flow can be walked
  // through without a mail provider. This is a full authentication bypass for
  // any account whose address an attacker knows — it is refused outright when
  // NODE_ENV=production (see the guard under the schema), and must never be set
  // anywhere real. Default off.
  DEV_FIXED_RESET_OTP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Prisma/migrations run as owner; runtime uses the two RLS roles.
  APP_DATABASE_URL: z.string().min(1),
  SERVICE_DATABASE_URL: z.string().min(1),

  // Auth secrets — set real values per environment (flagged for hardening).
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be >=32 chars"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  // 32-byte AES-256 key (hex, 64 chars) used to encrypt TOTP secrets at rest.
  TWO_FACTOR_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TWO_FACTOR_ENC_KEY must be 64 hex chars (32 bytes)"),

  // Where the member/admin apps live — used to build email verify/reset links.
  APP_BASE_URL: z.string().default("http://localhost:3000"),

  // OAuth — optional locally.
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Accept multiple Apple client ids (app bundle id + service id) comma-separated.
  APPLE_CLIENT_ID: z.string().optional(),

  // Stripe (Module 3) — optional locally; endpoints 503 until set. The webhook
  // signing secret is REQUIRED to accept webhooks (see payments routes).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().default("http://localhost:3000/checkout/success"),
  STRIPE_CANCEL_URL: z.string().default("http://localhost:3000/checkout/cancel"),

  // Media (Module 5) — all optional locally; the media endpoints 503 until set
  // (same pattern as Stripe/OAuth). FLAGGED FOR HUMAN HARDENING.
  // --- S3-compatible object storage (audio/images/assets/avatars source; private bucket,
  //     presigned URLs only). Provider = AWS S3 OR Cloudflare R2 (CR-005, authorized
  //     2026-07-28). R2 is S3-compatible: the SAME client + presign code drives both — R2 is
  //     selected purely by setting S3_ENDPOINT below (+ region "auto" + R2 credentials). Keeping
  //     S3_ENDPOINT unset falls back to AWS S3, so a rollback is a config flip, not a redeploy
  //     (CR-005 Q3). R2 encrypts objects at rest (AES-256) by default → §6 at-rest MUST is met. ---
  AWS_REGION: z.string().default("eu-west-2"), // set to "auto" for R2
  S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  // Cloudflare R2 endpoint, e.g. https://<accountid>.r2.cloudflarestorage.com. Unset ⇒ AWS S3
  // (the SDK's default regional endpoint). Set ⇒ the client targets R2 with path-style
  // addressing. Presign PUT/GET shapes are identical either way (CR-005). Ops config.
  S3_ENDPOINT: z.string().optional(),
  S3_UPLOAD_TTL_SECONDS: z.coerce.number().default(300), // 5-min PUT (contract §4)
  S3_DOWNLOAD_TTL_SECONDS: z.coerce.number().default(900), // 15-min GET
  // Content artwork CDN (G-7). CloudFront in front of the STILL-PRIVATE bucket via Origin
  // Access Control, restricted to the `images/*` prefix — see contracts §4. Artwork is not
  // tier-gated, so it is served from a stable, cacheable URL instead of being presigned per
  // request (a fresh URL every refresh breaks device caching: at 10k users every app open
  // would re-download every visible thumbnail from S3).
  // Unset ⇒ the backend falls back to a presigned GET so the response shape never varies and
  // local dev works. ⚠️ The distribution + OAC are an Agent 6 deliverable and MUST exist
  // before this is set in any environment — setting it without them yields 403s, and
  // pointing it at a public bucket would publish the tier-gated `audio/` prefix.
  MEDIA_CDN_BASE_URL: z.string().optional(),
  // The origin the S3 bucket's CORS rule must allow PUT from (contract §4). Ops config —
  // set it in the bucket, not in code. Default corrected from :3001; the admin runs on :3000.
  ADMIN_ORIGIN: z.string().default("http://localhost:3000"),
  // --- Video provider: Cloudflare Stream — signed playback (RS256 JWT) + direct upload ---
  // Video = Cloudflare Stream (contract §4 / CLAUDE.md §2 permit "Mux OR Cloudflare
  // Stream"; provider swapped from Mux 2026-07-17 on a human decision — no contract
  // change, see PROGRESS_LOG). ABR + signed playback + no-download, same as Mux.
  CF_ACCOUNT_ID: z.string().optional(), // direct-upload API
  CF_API_TOKEN: z.string().optional(), // direct-upload API (Stream:Edit)
  CF_STREAM_KEY_ID: z.string().optional(), // signing key id → JWT `kid`
  CF_STREAM_KEY_PEM: z.string().optional(), // base64-encoded PEM private key
  CF_STREAM_CUSTOMER_CODE: z.string().optional(), // customer-<CODE>.cloudflarestream.com
  PLAYBACK_TTL_SECONDS: z.coerce.number().default(3600), // 1-hour signed playback

  // "mock" makes S3 + Stream work locally with NO cloud account: uploads and playback
  // round-trip through an in-process mock so the member app, admin and QA can drive the
  // real contract shapes end to end. Mock media is unsigned and unauthenticated, so it is
  // allowed ONLY in an allow-listed non-prod NODE_ENV (media.ts `mockMediaAllowed`) — and
  // the "live" default here is the guard that actually protects production.
  // "live" = S3/R2 + Cloudflare Stream (presigned/signed). "mock" = dev-only in-process stand-in.
  // "local" = CR-007: media stored on THIS server's filesystem and served by us (S3/R2/Stream
  // kept as a config fallback). "local" is a real, signed driver, so — unlike "mock" — it is
  // allowed in production.
  MEDIA_DRIVER: z.enum(["live", "mock", "local"]).default("live"),
  MOCK_MEDIA_BASE_URL: z.string().default("http://localhost:4000"),

  // CR-007 local media driver. MEDIA_ROOT must be a PERSISTENT, BACKED-UP volume in production
  // (it holds member/paid media and must survive deploys/restarts). MEDIA_PUBLIC_BASE_URL is the
  // public origin the API stamps into media URLs (e.g. https://app.ashtaeight.com).
  // MEDIA_SIGNING_KEY signs the short-lived media URLs; falls back to JWT_SECRET when unset,
  // but a dedicated key is preferred so rotating media URLs never invalidates sessions.
  MEDIA_ROOT: z.string().default("./var/media"),
  MEDIA_PUBLIC_BASE_URL: z.string().default("http://localhost:4000"),
  MEDIA_SIGNING_KEY: z.string().min(32, "MEDIA_SIGNING_KEY must be >=32 chars").optional(),

  // Zoom (Module 6) — Server-to-Server OAuth. Optional locally; booking/session
  // creation 503s the Zoom call (best-effort) until set. FLAGGED FOR HUMAN HARDENING.
  // "mock" mints a well-formed but deliberately unreachable join URL so bookings and
  // live-cohort sessions carry a link without a Zoom account — see mocking.ts for the gate.
  ZOOM_DRIVER: z.enum(["live", "mock"]).default("live"),
  ZOOM_ACCOUNT_ID: z.string().optional(),
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),
  ZOOM_USER_ID: z.string().default("me"), // host account the meetings are created under

  // FCM (Module 8) — push only, standalone (no other Firebase). Optional locally;
  // pushes are a no-op until the service-account creds are set (boot-without-keys
  // pattern). FLAGGED FOR HUMAN HARDENING. FCM_PRIVATE_KEY may carry literal "\n".
  // "mock" reports a successful send without contacting FCM, so the delivery LOGIC
  // (sentAt stamping, stale-token pruning) runs locally. It cannot deliver to a device —
  // real push still needs credentials and hardware. See mocking.ts for the gate.
  FCM_DRIVER: z.enum(["live", "mock"]).default("live"),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
  // Notification timing knobs — change cadence without touching code.
  RENEWAL_REMINDER_DAYS: z.coerce.number().default(3),
  SESSION_REMINDER_LEAD_HOURS: z.coerce.number().default(24),
  NEW_CONTENT_PUSH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Email (Module 9) — Mailchimp Transactional (Mandrill). Optional locally;
  // sends LOG instead of delivering until the key + from-address are set (boot-
  // without-keys pattern). FLAGGED FOR HUMAN HARDENING (client-owned account).
  MAILCHIMP_TRANSACTIONAL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("Ashta Eight"),
  // Mandrill send endpoint (override for a regional endpoint or a test capture).
  MAILCHIMP_API_URL: z.string().default("https://mandrillapp.com/api/1.0/messages/send.json"),
  })
  .superRefine((v, ctx) => {
    // `*_DRIVER=mock` outside dev/test is a static configuration error, so it is refused
    // HERE — at boot, once, for all three integrations. It used to be a per-call throw in
    // mockEnabled(), which was the wrong layer twice over: Zoom's best-effort catch
    // SWALLOWED the throw (verified: NODE_ENV=production + ZOOM_DRIVER=mock returned 201
    // with a null link rather than refusing), and each consumer needed its own copy.
    // Nothing can catch a boot failure.
    const mocked = (["MEDIA_DRIVER", "ZOOM_DRIVER", "FCM_DRIVER"] as const).filter(
      (k) => v[k] === "mock",
    );
    if (mocked.length > 0 && !MOCK_OK_ENVS.has(v.NODE_ENV)) {
      ctx.addIssue({
        code: "custom",
        message: `${mocked.join(", ")}=mock is refused in NODE_ENV=${v.NODE_ENV} — mocks serve unauthenticated data and must never run outside ${[...MOCK_OK_ENVS].join("/")}`,
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment:\n", z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

// Refuse to boot rather than serve a known reset code in production. Same
// posture as the mock-media guard above: an unsafe combination must fail
// LOUDLY at startup, never be quietly ignored.
if (env.DEV_FIXED_RESET_OTP && env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.error(
    "FATAL: DEV_FIXED_RESET_OTP=true with NODE_ENV=production. This makes every " +
      "password-reset code guessable. Unset it before deploying.",
  );
  process.exit(1);
}
