import { JWT } from "google-auth-library";
import { env } from "./env";
import { mockEnabled } from "./mocking";

// FCM HTTP v1 transport (Module 8). Push ONLY — standalone, no firebase-admin
// SDK (CLAUDE.md: "FCM for push only, no other Firebase"). An OAuth2 access
// token is minted from the service-account creds via google-auth-library (already
// a dependency); the JWT client caches + refreshes the token internally. Same
// boot-without-keys pattern as stripe.ts / zoom.ts: unconfigured ⇒ pushes no-op,
// so local dev + the smoke test run without creds. FLAGGED FOR HUMAN HARDENING.

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// NOTE: does NOT consult the mock driver, deliberately — see zoom.ts. `sendToTokens`
// checks mockEnabled() first, so the mock branch returns before this is reached; an
// `if (FCM_DRIVER === "mock") return true` here was unreachable, and would lie to any
// future caller that used it as the mock gate (it never looks at NODE_ENV).
export function fcmConfigured(): boolean {
  return !!(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY);
}

let client: JWT | undefined;
function jwtClient(): JWT {
  if (!client) {
    client = new JWT({
      email: env.FCM_CLIENT_EMAIL,
      // .env stores the PEM with literal "\n"; restore real newlines.
      key: env.FCM_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      scopes: [SCOPE],
    });
  }
  return client;
}

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Per-token delivery outcome. `stale` ⇒ FCM says the token is dead → prune it.
export interface SendResult {
  token: string;
  ok: boolean;
  stale: boolean;
}

// Deliver one message to each token. FCM v1 is one-message-per-token (no
// multicast without the SDK); a cron fan-out loops these. Never throws — a bad
// token or transient FCM error must not roll back the caller's DB work.
// ponytail: sequential sends, fine for R1 volumes; parallelise/queue if a single
// fan-out grows large.
// Mock send — FCM_DRIVER=mock, dev/test only (gate: mocking.ts).
//
// SCOPE, honestly: this CANNOT deliver a push to a device. Real delivery needs credentials
// and hardware, and stays untested until both exist (TEST_REPORT §4). What it does unblock
// is the delivery LOGIC around the send, which has never executed without credentials —
// `sentAt` stamping and stale-token pruning (notifications/service.ts:41-47). The in-app
// notification row is written regardless of push, so `/me/notifications` already worked.
//
// A token beginning `stale-` reports as dead, so the pruning branch can be driven
// deterministically instead of waiting for FCM to retire a real token.
// On collision safety: do NOT reason from token length — it is irrelevant to a PREFIX
// match, and base64url legitimately contains "-". The real guarantee is reachability:
// env.ts refuses FCM_DRIVER=mock outside dev/test, so mockSend cannot run in production.
// A colliding token could therefore only mis-prune itself on a dev box.
const MOCK_STALE_PREFIX = "stale-";

function mockSend(tokens: string[], msg: PushMessage): SendResult[] {
  // eslint-disable-next-line no-console
  console.log(`[fcm:mock] would deliver "${msg.title}" to ${tokens.length} token(s)`);
  return tokens.map((token) => {
    const stale = token.startsWith(MOCK_STALE_PREFIX);
    return { token, ok: !stale, stale };
  });
}

export async function sendToTokens(tokens: string[], msg: PushMessage): Promise<SendResult[]> {
  if (tokens.length === 0) return [];
  if (mockEnabled(env.FCM_DRIVER)) return mockSend(tokens, msg);
  if (!fcmConfigured()) return [];
  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;
  let accessToken: string | null | undefined;
  try {
    accessToken = (await jwtClient().getAccessToken()).token;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fcm] auth failed", err);
    return tokens.map((token) => ({ token, ok: false, stale: false }));
  }

  const results: SendResult[] = [];
  for (const token of tokens) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: { token, notification: { title: msg.title, body: msg.body }, data: msg.data },
        }),
      });
      // 404 UNREGISTERED / 400 invalid token ⇒ the token is dead; prune it.
      const stale = res.status === 404 || res.status === 400;
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[fcm] send failed token=${token.slice(0, 12)}… status=${res.status}`);
      }
      results.push({ token, ok: res.ok, stale });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[fcm] send error", err);
      results.push({ token, ok: false, stale: false });
    }
  }
  return results;
}
