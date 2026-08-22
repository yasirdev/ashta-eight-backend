import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { TwoFactorSecret, User } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parseBody } from "../http";
import { sendAuthEmail } from "../email";
import { logger } from "../logger";
import { publicWriteLimiter, resetConfirmLimiter } from "../rate-limit";
import { avatarObjectKeyRe, avatarUrl, deleteObject, presignAvatarUpload } from "../media";
import { requireAdmin, requireAuth } from "./middleware";
import type { OAuthIdentity } from "./oauth";
import { verifyAppleToken, verifyGoogleToken } from "./oauth";
import { encryptSecret, generateSecret, otpauthUrl, verifyCode } from "./totp";
import {
  consumeVerificationToken,
  createVerificationToken,
  hashPassword,
  issueSession,
  revokeSession,
  rotateSession,
  signTwoFactorChallenge,
  verifyPassword,
  verifyTwoFactorChallenge,
} from "./tokens";

export const authRouter = Router();

const STAFF_ROLES = ["administrator", "coach", "content_manager", "pa"];

// The single path from "identity proven" → tokens. EVERY primary login route
// (password, Apple, Google) funnels through here so the staff-2FA gate can never
// be skipped on one path (was the OAuth-bypass bug). Staff with 2FA enabled get a
// challenge instead of tokens; /auth/2fa/verify then completes the exchange.
async function completeLogin(
  res: Response,
  user: User & { twoFactor?: TwoFactorSecret | null },
) {
  // A soft-deleted or admin-disabled account cannot log in by ANY path (password/
  // Apple/Google all funnel through here). Sessions were already revoked; this blocks
  // a fresh login. Deleted is permanent-ish; disabled is a reversible admin block.
  if (user.deletedAt) {
    throw new AppError(403, "account_deleted", "This account has been deleted");
  }
  if (user.disabledAt) {
    throw new AppError(403, "account_disabled", "This account has been disabled. Contact support.");
  }
  // twoFactor is `undefined` when the caller didn't join it (OAuth path) vs `null`
  // when joined-but-absent (password path). Fetch it for staff on the OAuth path.
  let twoFactor = user.twoFactor;
  if (twoFactor === undefined && STAFF_ROLES.includes(user.role)) {
    twoFactor = await prismaService.twoFactorSecret.findUnique({ where: { userId: user.id } });
  }
  if (STAFF_ROLES.includes(user.role) && twoFactor?.enabledAt) {
    return res.json({ twoFactorRequired: true, challengeId: signTwoFactorChallenge(user.id) });
  }
  const session = await issueSession(user.id, user.role);
  return res.json({ ...session, user: await serializeUser(user) });
}

// Client-safe user shape (never leak internal-only columns). ASYNC since G-8: `avatarUrl`
// is a short-lived presigned GET (personal data — NOT the CDN artwork uses), and it
// resolves to null when S3 is unconfigured/failing so a broken avatar can never break the
// login or /me response. `avatarObjectKey`/`locale`/`notes` are never serialized.
// CR-001 free-trial length in days. MUST match the `interval '15 days'` in
// policies.sql app.has_active_trial() — both express the same 15-day window.
export const TRIAL_DAYS = 15;

const serializeUser = async (u: User) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  emailVerified: u.emailVerifiedAt != null,
  phone: u.phone,
  dateOfBirth: u.dateOfBirth, // G-12 — Personal Data screen (date, nullable)
  gender: u.gender, // G-12 (free text, nullable)
  avatarUrl: await avatarUrl(u.avatarObjectKey), // G-8 (15-min presigned GET, or null)
  // CR-001: when the trial ends (start + 15d), or null if never trialed. The client
  // reads "active" as trialEndsAt != null && trialEndsAt > now; an expired trial keeps
  // a past date. Access is enforced in RLS regardless — this is display/routing only.
  trialEndsAt: u.trialStartedAt
    ? new Date(u.trialStartedAt.getTime() + TRIAL_DAYS * 86_400_000)
    : null,
  createdAt: u.createdAt,
});

// ─── Register ────────────────────────────────────────────────────────────────
const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120).optional(),
  // UUID-pinned to match POST /recommendation: this key claims an anonymous intake
  // (personal data) at signup, so an arbitrary client-chosen string must not be trusted
  // as the credential. Was unbounded `z.string()`.
  recommendationSessionKey: z.string().uuid().optional(),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const existing = await prismaService.user.findUnique({ where: { email: body.email } });
    if (existing) throw new AppError(409, "email_taken", "An account with this email already exists");

    const passwordHash = await hashPassword(body.password);
    const user = await prismaService
      .$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { email: body.email, displayName: body.displayName, role: "member" },
        });
        // For password identities providerSubject = the user's own id (schema note).
        await tx.authIdentity.create({
          data: { userId: u.id, provider: "password", providerSubject: u.id, passwordHash },
        });
        // Attach an anonymous questionnaire result captured before signup.
        if (body.recommendationSessionKey) {
          await tx.recommendationRequest.updateMany({
            where: { sessionKey: body.recommendationSessionKey, userId: null },
            data: { userId: u.id },
          });
        }
        return u;
      })
      // The findUnique above is best-effort; the unique index is the real guard.
      // Map a concurrent-insert collision to the same 409, not a 500.
      .catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new AppError(409, "email_taken", "An account with this email already exists");
        }
        throw e;
      });

    const token = await createVerificationToken(user.id, "email_verify");
    await sendAuthEmail(user.email, "verify_email", token);
    res.status(201).json({ userId: user.id });
  }),
);

// ─── Login (email/password) ──────────────────────────────────────────────────
const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const user = await prismaService.user.findUnique({
      where: { email: body.email },
      include: { identities: { where: { provider: "password" } }, twoFactor: true },
    });
    const hash = user?.identities[0]?.passwordHash;
    // Generic failure — do not reveal whether the email exists.
    if (!user || !hash || !(await verifyPassword(body.password, hash))) {
      throw new AppError(401, "invalid_credentials", "Invalid email or password");
    }
    return completeLogin(res, user);
  }),
);

// ─── 2FA ─────────────────────────────────────────────────────────────────────
const twoFaVerifySchema = z.object({ challengeId: z.string(), code: z.string().min(6).max(10) });

authRouter.post(
  "/2fa/verify",
  asyncHandler(async (req, res) => {
    const body = parseBody(twoFaVerifySchema, req.body);
    const userId = verifyTwoFactorChallenge(body.challengeId);
    const [user, secretRow] = await Promise.all([
      prismaService.user.findUnique({ where: { id: userId } }),
      prismaService.twoFactorSecret.findUnique({ where: { userId } }),
    ]);
    if (!user || !secretRow?.enabledAt || !verifyCode(body.code, secretRow.secret)) {
      throw new AppError(401, "invalid_code", "Invalid 2FA code");
    }
    const session = await issueSession(user.id, user.role);
    res.json({ ...session, user: await serializeUser(user) });
  }),
);

authRouter.post(
  "/2fa/setup",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const user = await prismaService.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = generateSecret();
    // (Re)provision an unconfirmed secret — enabledAt stays null until /enable.
    await prismaService.twoFactorSecret.upsert({
      where: { userId },
      create: { userId, secret: encryptSecret(secret) },
      update: { secret: encryptSecret(secret), enabledAt: null },
    });
    res.json({ otpauthUrl: otpauthUrl(secret, user.email), secret });
  }),
);

authRouter.post(
  "/2fa/enable",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().min(6).max(10) }), req.body);
    const userId = req.auth!.userId;
    const row = await prismaService.twoFactorSecret.findUnique({ where: { userId } });
    if (!row) throw new AppError(400, "no_2fa_setup", "Call /auth/2fa/setup first");
    if (!verifyCode(body.code, row.secret)) throw new AppError(401, "invalid_code", "Invalid 2FA code");
    await prismaService.twoFactorSecret.update({
      where: { userId },
      data: { enabledAt: row.enabledAt ?? new Date() },
    });
    res.json({ ok: true });
  }),
);

// ─── OAuth (Apple / Google) ──────────────────────────────────────────────────
// Resolve a verified provider identity to a local user, creating/linking safely.
async function upsertOAuthUser(id: OAuthIdentity): Promise<User> {
  const found = await prismaService.authIdentity.findUnique({
    where: { provider_providerSubject: { provider: id.provider, providerSubject: id.subject } },
    include: { user: true },
  });
  if (found) return found.user;

  if (!id.email) {
    // No linkable email and no existing identity → cannot provision an account.
    throw new AppError(400, "oauth_no_email", "Provider did not supply an email; cannot create account");
  }
  const byEmail = await prismaService.user.findUnique({ where: { email: id.email } });
  if (byEmail) {
    // Link to the existing account ONLY if the provider verified the email —
    // otherwise an attacker could claim someone's account via an unverified one.
    if (!id.emailVerified) {
      throw new AppError(409, "email_unverified", "Provider email is not verified; cannot link account");
    }
    await prismaService.authIdentity.create({
      data: { userId: byEmail.id, provider: id.provider, providerSubject: id.subject },
    });
    return byEmail;
  }
  return prismaService.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: id.email!,
        role: "member",
        emailVerifiedAt: id.emailVerified ? new Date() : null,
      },
    });
    await tx.authIdentity.create({
      data: { userId: u.id, provider: id.provider, providerSubject: id.subject },
    });
    return u;
  });
}

authRouter.post(
  "/apple",
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ identityToken: z.string(), nonce: z.string().optional() }),
      req.body,
    );
    const identity = await verifyAppleToken(body.identityToken, body.nonce);
    const user = await upsertOAuthUser(identity);
    return completeLogin(res, user);
  }),
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ idToken: z.string() }), req.body);
    const identity = await verifyGoogleToken(body.idToken);
    const user = await upsertOAuthUser(identity);
    return completeLogin(res, user);
  }),
);

// ─── Session lifecycle ───────────────────────────────────────────────────────
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ refresh: z.string() }), req.body);
    const session = await rotateSession(body.refresh);
    res.json(session);
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ refresh: z.string() }), req.body);
    await revokeSession(body.refresh);
    res.json({ ok: true });
  }),
);

// ─── Email verification ──────────────────────────────────────────────────────
authRouter.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ token: z.string() }), req.body);
    const userId = await consumeVerificationToken(body.token, "email_verify");
    await prismaService.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    res.json({ ok: true });
  }),
);

// Always 200 (no account enumeration). Only acts if the account exists & unverified.
authRouter.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ email: z.email() }), req.body);
    const user = await prismaService.user.findUnique({ where: { email: body.email } });
    if (user && !user.emailVerifiedAt) {
      const token = await createVerificationToken(user.id, "email_verify");
      await sendAuthEmail(user.email, "verify_email", token);
    }
    res.json({ ok: true });
  }),
);

// ─── Password reset ──────────────────────────────────────────────────────────
// Always 200 (no enumeration). Only acts if a password identity exists.
authRouter.post(
  "/reset-request",
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ email: z.email() }), req.body);
    const user = await prismaService.user.findUnique({
      where: { email: body.email },
      include: { identities: { where: { provider: "password" } } },
    });
    if (user && user.identities.length > 0) {
      const token = await createVerificationToken(user.id, "password_reset");
      await sendAuthEmail(user.email, "reset_password", token);
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/reset-confirm",
  resetConfirmLimiter,
  asyncHandler(async (req, res) => {
    // `email` is REQUIRED alongside the code: the reset token is now a 6-digit
    // code, which is only meaningful against a named account. See
    // SCOPE_CHANGE_LOG CR-002 — this amends contracts §3's {token, password}.
    const body = parseBody(
      z.object({
        email: z.email(),
        token: z.string(),
        password: z.string().min(8).max(200),
      }),
      req.body,
    );
    const account = await prismaService.user.findUnique({
      where: { email: body.email },
      select: { id: true },
    });
    // Same generic failure whether the address is unknown or the code is wrong,
    // so this endpoint cannot be used to enumerate accounts either.
    if (!account) throw new AppError(400, "invalid_token", "Invalid or expired token");
    const userId = await consumeVerificationToken(body.token, "password_reset", account.id);
    const passwordHash = await hashPassword(body.password);
    await prismaService.$transaction(async (tx) => {
      // Update (or create, for an OAuth-only user setting a password) the identity.
      const existing = await tx.authIdentity.findFirst({
        where: { userId, provider: "password" },
      });
      if (existing) {
        await tx.authIdentity.update({ where: { id: existing.id }, data: { passwordHash } });
      } else {
        await tx.authIdentity.create({
          data: { userId, provider: "password", providerSubject: userId, passwordHash },
        });
      }
      // Reset invalidates all existing sessions.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    res.json({ ok: true });
  }),
);

// ─── Change password (G-13) ──────────────────────────────────────────────────
// Authenticated password change for a member who KNOWS their current password (distinct
// from the email-code reset for a member who does NOT). Mirrors reset-confirm's post-steps:
// verify current via bcrypt, rotate the password identity, revoke ALL sessions. On the
// `/auth` router, so authLimiter (15/min) already caps online guessing of the current pw.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const body = parseBody(changePasswordSchema, req.body);
    // The password identity is the only thing that carries a hash. An OAuth-only account
    // has none — it cannot "change" a password it never set (it must use reset to set one).
    const identity = await prismaService.authIdentity.findFirst({
      where: { userId, provider: "password" },
    });
    if (!identity?.passwordHash || !(await verifyPassword(body.currentPassword, identity.passwordHash))) {
      // Generic — do not distinguish "no password identity" from "wrong current password".
      throw new AppError(400, "invalid_credentials", "Current password is incorrect");
    }
    const passwordHash = await hashPassword(body.newPassword);
    await prismaService.$transaction(async (tx) => {
      await tx.authIdentity.update({ where: { id: identity.id }, data: { passwordHash } });
      // A password change invalidates every existing session (same as reset). The client
      // re-authenticates; a leaked/old refresh token is dead.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    res.json({ ok: true });
  }),
);

// ─── Profile (RLS-enforced, app role) — mounted at /me ───────────────────────
export const meRouter = Router();

meRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const user = await asUser(userId, role, (tx) => tx.user.findUnique({ where: { id: userId } }));
    if (!user) throw new AppError(404, "not_found", "User not found");
    // Response is {user} per contract §3. The client reads its tier from the
    // access-token `tier` claim; a live tier field on /me would need a contract change.
    res.json({ user: await serializeUser(user) });
  }),
);

// POST /me/avatar/presign (G-8) — a MEMBER-only presign with the category fixed to
// `avatar` server-side (never opening the admin presign's enum to members). Rate-limited
// (publicWriteLimiter) because it mints signed writes to a bucket. `sizeBytes` optional
// (see presignAvatarUpload); the client re-encodes to strip EXIF before the PUT.
meRouter.post(
  "/avatar/presign",
  publicWriteLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const body = parseBody(
      z.object({
        contentType: z.string().min(1).max(100),
        sizeBytes: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const out = await presignAvatarUpload(userId, body.contentType, body.sizeBytes);
    res.json(out); // { uploadUrl, objectKey, expiresAt }
  }),
);

// POST /me/trial (CR-001) — activate the 15-day free trial ONCE, no payment, no
// Stripe. The guarded updateMany only writes when trial_started_at is still NULL, so a
// second attempt matches 0 rows → 409. Service role because this is an entitlement
// grant (trial_started_at is frozen for non-staff by the trigger), scoped to the
// caller's own JWT userId — the same sanctioned member-write-via-service pattern as
// device registration / booking cancel. RLS opens the free set from here on.
meRouter.post(
  "/trial",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const startedAt = new Date();
    const claimed = await prismaService.user.updateMany({
      where: { id: userId, trialStartedAt: null },
      data: { trialStartedAt: startedAt },
    });
    if (claimed.count !== 1) {
      throw new AppError(409, "trial_already_used", "Your free trial has already been used");
    }
    res.json({ trialEndsAt: new Date(startedAt.getTime() + TRIAL_DAYS * 86_400_000) });
  }),
);

// DELETE /me — soft-delete the account. Sets users.deleted_at (service role; the
// column is frozen for non-staff by the trigger) and revokes every session, in one
// transaction. Data is RETAINED (soft); login is then blocked (completeLogin guard).
// Idempotent: re-deleting just re-stamps the marker. GDPR hard-erasure is a later sweep.
meRouter.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    await prismaService.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    res.json({ ok: true });
  }),
);

const patchMeSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  phone: z.string().min(3).max(40).optional(),
  // G-12 — Personal Data. `nullish` so a member can clear a value (null) or leave it
  // untouched (absent → Prisma ignores). DOB is GDPR personal data, handled like the row.
  dateOfBirth: z.coerce.date().nullish(),
  gender: z.string().min(1).max(60).nullish(),
  // G-8 — validated against the per-user key regex in the handler (it needs `userId`).
  // `locale` is intentionally NOT accepted in R1 (no user-facing language picker; CR-003).
  avatarObjectKey: z.string().max(200).nullish(),
});

meRouter.patch(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { avatarObjectKey, ...rest } = parseBody(patchMeSchema, req.body);
    // `role`/`locale` are intentionally not accepted here; the DB trigger also blocks role.
    const data: Prisma.UserUpdateInput = { ...rest };

    if (avatarObjectKey !== undefined) {
      // The regex is the guard (§5.4) against a pointer into the tier-gated `audio/`
      // namespace: a non-null key MUST live under exactly `avatars/<thisUser>/<uuid>`.
      // null clears the avatar.
      if (avatarObjectKey !== null && !avatarObjectKeyRe(userId).test(avatarObjectKey)) {
        throw new AppError(400, "invalid_object_key", "avatarObjectKey must be an avatars/<you>/<uuid> image key");
      }
      data.avatarObjectKey = avatarObjectKey;
    }

    let prevAvatarKey: string | null = null;
    const user = await asUser(userId, role, async (tx) => {
      if (avatarObjectKey !== undefined) {
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { avatarObjectKey: true } });
        prevAvatarKey = cur?.avatarObjectKey ?? null;
      }
      return tx.user.update({ where: { id: userId }, data });
    });

    // Best-effort: delete the object we just replaced/cleared so orphans (personal data)
    // don't accumulate. Never fails the PATCH — logged only.
    if (avatarObjectKey !== undefined && prevAvatarKey && prevAvatarKey !== avatarObjectKey) {
      const ok = await deleteObject(prevAvatarKey);
      if (!ok) logger.warn({ userId }, "avatar replace: previous S3 object not deleted (best-effort)");
    }
    res.json({ user: await serializeUser(user) });
  }),
);
