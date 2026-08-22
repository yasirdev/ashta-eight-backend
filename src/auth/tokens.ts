import { createHash, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { VerificationPurpose } from "@prisma/client";
import { env } from "../env";
import { prismaService } from "../db";
import { AppError } from "../http";

// ─── Passwords ───────────────────────────────────────────────────────────────
// bcrypt cost 12. bcryptjs verifies the pgcrypto-generated $2a$ hash the seed
// created for the first admin, so the seeded credential logs in unchanged.
const BCRYPT_ROUNDS = 12;
export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_ROUNDS);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// ─── Access JWT ──────────────────────────────────────────────────────────────
// Short-lived. `role` is authoritative for setting the RLS `app.user_role` GUC.
// `tier` is an informational convenience claim for the client UI ONLY — server
// access decisions always recompute tier in the DB (app.current_tier_rank()),
// never trusting this claim.
export interface AccessClaims {
  sub: string;
  role: string;
  tier: number;
}

export function signAccessToken(claims: AccessClaims): string {
  const { sub, ...rest } = claims;
  return jwt.sign(rest, env.JWT_SECRET, {
    subject: sub,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    // Pin the algorithm — never let a token's own header pick it (alg-confusion).
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (p.typ) throw new Error("wrong token type"); // reject challenge tokens
    return { sub: p.sub as string, role: p.role, tier: p.tier ?? 0 };
  } catch {
    throw new AppError(401, "invalid_token", "Invalid or expired access token");
  }
}

// A short-lived token proving "password step passed, awaiting 2FA". Stateless —
// avoids a challenges table.
export function signTwoFactorChallenge(userId: string): string {
  return jwt.sign({ typ: "2fa" }, env.JWT_SECRET, { subject: userId, expiresIn: "5m" });
}

export function verifyTwoFactorChallenge(token: string): string {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (p.typ !== "2fa") throw new Error("wrong token type");
    return p.sub as string;
  } catch {
    throw new AppError(401, "invalid_challenge", "Invalid or expired 2FA challenge");
  }
}

// Member's active tier rank, computed authoritatively from the DB (mirrors the
// RLS helper app.current_tier_rank). Used only to stamp the informational claim.
export async function activeTierRank(userId: string): Promise<number> {
  const rows = await prismaService.$queryRaw<{ rank: number }[]>`
    SELECT COALESCE(MAX(p.tier_rank), 0)::int AS rank
    FROM subscriptions s
    JOIN programmes p ON p.id = s.programme_id
    WHERE s.user_id = ${userId}::uuid
      AND s.status = 'active'
      AND (s.current_period_end IS NULL OR s.current_period_end > now())`;
  return rows[0]?.rank ?? 0;
}

// ─── Refresh tokens (server-side sessions, 30-day) ───────────────────────────
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface IssuedSession {
  access: string;
  refresh: string;
}

// Issue an access token + a fresh refresh-token row. Returns the RAW refresh
// token (only its hash is stored — the row never holds the recoverable secret).
export async function issueSession(
  userId: string,
  role: string,
  deviceLabel?: string,
): Promise<IssuedSession> {
  const tier = await activeTierRank(userId);
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await prismaService.refreshToken.create({
    data: { userId, tokenHash: sha256(raw), expiresAt, deviceLabel },
  });
  return { access: signAccessToken({ sub: userId, role, tier }), refresh: raw };
}

// Rotate: validate the presented refresh token, revoke it, issue a new pair.
// One-time use — a replayed (already-revoked) token is rejected.
export async function rotateSession(rawRefresh: string): Promise<IssuedSession> {
  const row = await prismaService.refreshToken.findUnique({
    where: { tokenHash: sha256(rawRefresh) },
    include: { user: true },
  });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) {
    throw new AppError(401, "invalid_refresh", "Invalid or expired refresh token");
  }
  // Atomically claim the token: the conditional revoke only affects a row still
  // un-revoked, so two concurrent rotations of the same token can't both succeed
  // (closes the check-then-act race). ponytail: single-token revoke; full
  // theft-response (revoke the whole session family on replay) is the human
  // hardening pass — see PROGRESS_LOG.
  const claimed = await prismaService.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new AppError(401, "invalid_refresh", "Invalid or expired refresh token");
  }
  return issueSession(row.userId, row.user.role, row.deviceLabel ?? undefined);
}

// Revoke a single refresh token (logout). Idempotent — unknown/already-revoked
// tokens simply no-op so logout always returns ok.
export async function revokeSession(rawRefresh: string): Promise<void> {
  await prismaService.refreshToken.updateMany({
    where: { tokenHash: sha256(rawRefresh), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ─── Verification / reset tokens (single-use, expiring) ──────────────────────
const VERIFY_TTL_MS = 24 * 3_600_000; // email verify
const RESET_TTL_MS = 3_600_000; // password reset — tighter window

/// The reset code the member types into the app's six boxes. Six digits, drawn
/// from `randomInt` (CSPRNG) — not `Math.random`.
///
/// A six-digit code is only 10⁶ possibilities, so it is safe ONLY while guesses
/// are limited: `resetConfirmLimiter` caps attempts, and the code dies after one
/// use or RESET_TTL_MS. Per-identity lockout is still outstanding — see
/// PENDING_LOG; the current limiter is per-IP and in-memory.
export const RESET_CODE_LENGTH = 6;

/// The fixed code served when DEV_FIXED_RESET_OTP is on. Never reachable in
/// production: env.ts refuses to boot in that combination.
export const DEV_FIXED_RESET_CODE = "000000";

function newResetCode(): string {
  if (env.DEV_FIXED_RESET_OTP) return DEV_FIXED_RESET_CODE;
  return randomInt(0, 10 ** RESET_CODE_LENGTH)
    .toString()
    .padStart(RESET_CODE_LENGTH, "0");
}

// Create a single-use token for `purpose`; returns the RAW token to email.
//
// Password resets return a typed 6-digit CODE (the app collects it in boxes);
// email verification keeps the long opaque link token.
export async function createVerificationToken(
  userId: string,
  purpose: VerificationPurpose,
): Promise<string> {
  const isReset = purpose === "password_reset";
  const raw = isReset ? newResetCode() : randomBytes(32).toString("base64url");
  const ttl = isReset ? RESET_TTL_MS : VERIFY_TTL_MS;
  if (isReset) {
    // Only one live code per account: re-requesting supersedes the previous one
    // rather than leaving several valid. It also keeps the unique tokenHash from
    // colliding when the same code is drawn twice for one user — a certainty
    // under DEV_FIXED_RESET_OTP, and possible anyway across 10⁶ values.
    await prismaService.verificationToken.deleteMany({
      where: { userId, purpose, usedAt: null },
    });
  }
  await prismaService.verificationToken.create({
    data: {
      userId,
      purpose,
      // Reset codes are short, so the stored hash binds the code to the
      // account. Without that, sha256("000000") is one row for the whole
      // system: it would collide between members (tokenHash is unique) and
      // let anyone who guesses a code reset whoever happens to hold it.
      tokenHash: isReset ? resetCodeHash(userId, raw) : sha256(raw),
      expiresAt: new Date(Date.now() + ttl),
    },
  });
  return raw;
}

// Hash a reset code together with the account it belongs to.
const resetCodeHash = (userId: string, code: string) => sha256(`${userId}:${code}`);

// Consume a token: must exist, match purpose, be unused and unexpired. Marks it
// used and returns the userId. Throws 400 otherwise.
//
// `scopeUserId` is REQUIRED for password_reset, because a 6-digit code is only
// meaningful against a known account (see createVerificationToken).
export async function consumeVerificationToken(
  rawToken: string,
  purpose: VerificationPurpose,
  scopeUserId?: string,
): Promise<string> {
  if (purpose === "password_reset" && !scopeUserId) {
    throw new AppError(400, "invalid_token", "Invalid or expired token");
  }
  const row = await prismaService.verificationToken.findUnique({
    where: {
      tokenHash: scopeUserId ? resetCodeHash(scopeUserId, rawToken) : sha256(rawToken),
    },
  });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= new Date()) {
    throw new AppError(400, "invalid_token", "Invalid or expired token");
  }
  await prismaService.verificationToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  return row.userId;
}
