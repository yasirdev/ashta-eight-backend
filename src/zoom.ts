import { randomInt, randomUUID } from "node:crypto";
import { env } from "./env";
import { AppError } from "./http";
import { mockEnabled } from "./mocking";

// Zoom meeting creation via Server-to-Server OAuth (Module 6). Real API calls,
// but 503s when unconfigured (same pattern as stripe.ts / media.ts) so bookings
// work locally without Zoom creds — callers treat the Zoom step as best-effort.
// FLAGGED FOR HUMAN HARDENING (external-integration lane).

// NOTE: this does NOT consult the mock driver, deliberately. `createMeeting` checks
// mockEnabled() first, so the mock branch returns before any credential check — an earlier
// `if (ZOOM_DRIVER === "mock") return true` here was unreachable dead code, and worse, it
// invited a future caller to treat this as the mock gate (which it isn't: it never looks at
// NODE_ENV). Nothing outside this file calls it today.
function configured(): boolean {
  return !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
}
export { configured as zoomConfigured };

// Cache the S2S token until ~1 min before expiry (tokens last ~1h).
let cached: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (!configured()) throw new AppError(503, "zoom_unconfigured", "Zoom is not configured");
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID!)}`,
    { method: "POST", headers: { authorization: `Basic ${basic}` } },
  );
  if (!res.ok) throw new AppError(502, "zoom_auth_failed", `Zoom OAuth failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

// Mock meeting — ZOOM_DRIVER=mock, dev/test only (gate: mocking.ts).
// The host is deliberately `mock.zoom.invalid`: `.invalid` is reserved by RFC 2606 and can
// NEVER resolve, so the link is well-formed (the app can render and attempt it) but is
// unmistakably fake. A realistic `https://zoom.us/j/<id>` would look real and 404 — which
// reads as "Zoom is broken" rather than "Zoom is not configured", and invites someone to
// mistake a mock for a working integration. The id is numeric like a real Zoom meeting id,
// so any client-side parsing gets a representative shape.
function mockMeeting(args: { topic: string }): { meetingId: string; joinUrl: string } {
  const meetingId = String(randomInt(10_000_000_000, 99_999_999_999));
  const pwd = randomUUID().slice(0, 10);
  return {
    meetingId,
    joinUrl: `https://mock.zoom.invalid/j/${meetingId}?pwd=${pwd}#${encodeURIComponent(args.topic)}`,
  };
}

// Create a scheduled meeting. Returns the provider ids stored on the booking/session.
export async function createMeeting(args: {
  topic: string;
  startTime: Date;
  durationMinutes: number;
}): Promise<{ meetingId: string; joinUrl: string }> {
  if (mockEnabled(env.ZOOM_DRIVER)) return mockMeeting(args);
  const token = await accessToken();
  const res = await fetch(
    `https://api.zoom.us/v2/users/${encodeURIComponent(env.ZOOM_USER_ID)}/meetings`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        topic: args.topic,
        type: 2, // scheduled
        start_time: args.startTime.toISOString(),
        duration: Math.max(1, Math.round(args.durationMinutes)),
        timezone: "UTC",
        settings: { join_before_host: false, waiting_room: true },
      }),
    },
  );
  if (!res.ok) throw new AppError(502, "zoom_create_failed", `Zoom meeting create failed (${res.status})`);
  const body = (await res.json()) as { id: number; join_url: string };
  return { meetingId: String(body.id), joinUrl: body.join_url };
}
