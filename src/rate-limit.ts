import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

// Rate limiting (Agent 7 finding S1). Closes the M2 Auth BLOCK — no brute-force
// protection on the credential surface — plus the M10/M11 public-write WARNs.
//
// ponytail: default in-memory store = per-process counters. Fine for a 1–2 instance
// launch; behind a horizontally-scaled fleet each instance counts independently, so the
// effective limit multiplies by instance count. Upgrade path: `rate-limit-redis` with a
// shared store — swap the `store` option, nothing else changes.
function make(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    // Contract §3 error envelope, not the library's default text.
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests — slow down." },
      }),
  });
}

/// Generous global backstop against blunt floods (every non-webhook endpoint).
export const globalLimiter = make(60_000, 300);

/// Strict limiter for the credential surface: login, 2FA verify, password reset.
/// This is the control the M2 BLOCK required.
export const authLimiter = make(60_000, 15);

/// Public unauthenticated writes: POST /leads, POST /recommendation. Generous for a
/// human (who submits once), low enough to blunt scripted abuse.
export const publicWriteLimiter = make(60_000, 20);

/// Guess budget for the 6-digit reset code. Ten attempts per 15 minutes against
/// 10⁶ possibilities makes exhaustion hopeless within the code's 1-hour life.
///
/// ⚠️ Still per-IP and in-memory, so a distributed attacker sees a fresh budget
/// per source and a restart clears it. Per-identity lockout + a shared store are
/// the outstanding hardening — see PENDING_LOG.
export const resetConfirmLimiter = make(15 * 60_000, 10);
