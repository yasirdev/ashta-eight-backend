import { OAuth2Client } from "google-auth-library";
import { env } from "../env";
import { AppError } from "../http";

export interface OAuthIdentity {
  provider: "apple" | "google";
  subject: string; // provider `sub` — stable per-user id
  email?: string;
  emailVerified: boolean;
}

// ── Google ───────────────────────────────────────────────────────────────────
// Verify the Google ID token server-side against Google's certs (signature, exp,
// issuer) with `audience` pinned to our client id — never trust a client-decoded
// token. google-auth-library caches Google's public keys.
let googleClient: OAuth2Client | undefined;

export async function verifyGoogleToken(idToken: string): Promise<OAuthIdentity> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, "oauth_unconfigured", "Google sign-in is not configured");
  }
  googleClient ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AppError(401, "invalid_google_token", "Google token verification failed");
  }
  if (!payload?.sub) throw new AppError(401, "invalid_google_token", "Google token missing subject");
  return {
    provider: "google",
    subject: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
  };
}

// ── Apple ────────────────────────────────────────────────────────────────────
// Verify Apple's identity token against Apple's JWKS. `jose` v6 is ESM-only, so
// import it dynamically to keep this project CommonJS. Keyset is created lazily
// and cached across calls (createRemoteJWKSet caches Apple's keys internally).
let appleJwks: unknown;

export async function verifyAppleToken(identityToken: string, nonce?: string): Promise<OAuthIdentity> {
  if (!env.APPLE_CLIENT_ID) {
    throw new AppError(503, "oauth_unconfigured", "Apple sign-in is not configured");
  }
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  appleJwks ??= createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

  // Bundle id + service id may both be valid audiences — accept any configured.
  const audiences = env.APPLE_CLIENT_ID.split(",").map((s) => s.trim());
  let payload;
  try {
    ({ payload } = await jwtVerify(identityToken, appleJwks as never, {
      issuer: "https://appleid.apple.com",
      audience: audiences,
    }));
  } catch {
    throw new AppError(401, "invalid_apple_token", "Apple token verification failed");
  }
  // Replay/binding guard: if the client supplied a nonce, it must match.
  if (nonce && payload.nonce !== nonce) {
    throw new AppError(401, "invalid_apple_token", "Apple token nonce mismatch");
  }
  if (!payload.sub) throw new AppError(401, "invalid_apple_token", "Apple token missing subject");
  return {
    provider: "apple",
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    // Apple sends email_verified as the string "true"/"false" or a boolean.
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}
