// Module 2 (Auth) end-to-end smoke test. Run against a live server + DB:
//   PORT=4100 npx tsx src/index.ts   (in another shell)
//   BASE=http://localhost:4100 node scripts/module2-smoke.mjs
// Reads the server's stdout log (passed as LOGFILE) to recover emailed tokens,
// since only token HASHES are stored in the DB (never the raw token).
import { readFileSync } from "node:fs";
import { generate } from "otplib";

const BASE = process.env.BASE || "http://localhost:4100";
const LOGFILE = process.env.LOGFILE;
let pass = 0,
  fail = 0;

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓", label);
  } else {
    fail++;
    console.error("  ✗ FAIL:", label);
  }
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

// Recover the newest emailed token of a kind from the server log stub lines:
//   [email:verify_email] to=... link=...?token=RAW
function lastToken(kind) {
  if (!LOGFILE) throw new Error("LOGFILE env not set");
  const log = readFileSync(LOGFILE, "utf8");
  const re = new RegExp(`\\[email:${kind}\\][^\\n]*token=([A-Za-z0-9_-]+)`, "g");
  let m,
    last = null;
  while ((m = re.exec(log))) last = m[1];
  if (!last) throw new Error("no " + kind + " token in log");
  return last;
}

const email = `member+${Date.now()}@example.com`;
const pw = "hunter2pw!";

console.log("Auth smoke test against", BASE);

// 1. register
let r = await call("POST", "/auth/register", { email, password: pw, displayName: "Test M" });
ok(r.status === 201 && r.json.userId, "register → 201 + userId");
const userId = r.json?.userId;

// 2. duplicate register → 409
r = await call("POST", "/auth/register", { email, password: pw });
ok(r.status === 409, "duplicate register → 409");

// 3. weak password → 400
r = await call("POST", "/auth/register", { email: "x@y.com", password: "short" });
ok(r.status === 400, "weak password → 400");

// 4. login member
r = await call("POST", "/auth/login", { email, password: pw });
ok(r.status === 200 && r.json.access && r.json.refresh, "login → access+refresh");
let access = r.json?.access,
  refresh = r.json?.refresh;

// 5. wrong password → 401 (generic)
r = await call("POST", "/auth/login", { email, password: "wrongwrong" });
ok(r.status === 401 && r.json.error.code === "invalid_credentials", "bad password → 401 generic");

// 6. GET /me (RLS app-role path)
r = await call("GET", "/me", null, access);
ok(r.status === 200 && r.json.user.id === userId, "GET /me → own user");
ok(r.json?.user?.emailVerified === false, "GET /me → emailVerified false pre-verify");
ok(r.json?.user?.role === "member", "GET /me → role member");
ok(r.json?.tier === undefined, "GET /me → response is {user} only (contract §3)");

// 7. GET /me no token → 401
r = await call("GET", "/me");
ok(r.status === 401, "GET /me without token → 401");

// 8. PATCH /me
r = await call("PATCH", "/me", { displayName: "Renamed", phone: "+441234567890" }, access);
ok(r.status === 200 && r.json.user.displayName === "Renamed", "PATCH /me updates profile");

// 9. member cannot access admin-only 2FA setup → 403
r = await call("POST", "/auth/2fa/setup", {}, access);
ok(r.status === 403, "member → /auth/2fa/setup 403");

// 10. verify-email (token from log)
const verifyTok = lastToken("verify_email");
r = await call("POST", "/auth/verify-email", { token: verifyTok });
ok(r.status === 200 && r.json.ok, "verify-email → ok");
r = await call("POST", "/auth/verify-email", { token: verifyTok });
ok(r.status === 400, "verify-email reuse → 400 (single-use)");

// 11. refresh rotation + reuse detection
r = await call("POST", "/auth/refresh", { refresh });
ok(r.status === 200 && r.json.access && r.json.refresh, "refresh → new pair");
const rotated = r.json?.refresh;
r = await call("POST", "/auth/refresh", { refresh });
ok(r.status === 401, "old refresh reuse → 401 (rotated/revoked)");

// 12. logout revokes the rotated refresh
r = await call("POST", "/auth/logout", { refresh: rotated }, access);
ok(r.status === 200, "logout → ok");
r = await call("POST", "/auth/refresh", { refresh: rotated });
ok(r.status === 401, "refresh after logout → 401");

// 13. password reset flow
r = await call("POST", "/auth/reset-request", { email });
ok(r.status === 200 && r.json.ok, "reset-request → 200");
r = await call("POST", "/auth/reset-request", { email: "nobody@nowhere.com" });
ok(r.status === 200, "reset-request unknown email → 200 (no enumeration)");
const resetTok = lastToken("reset_password");
const newPw = "brandNewPw!9";
r = await call("POST", "/auth/reset-confirm", { token: resetTok, password: newPw });
ok(r.status === 200, "reset-confirm → 200");
r = await call("POST", "/auth/login", { email, password: newPw });
ok(r.status === 200 && r.json.access, "login with new password → 200");
r = await call("POST", "/auth/login", { email, password: pw });
ok(r.status === 401, "login with old password → 401");

// 14. Admin 2FA lifecycle
r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200 && r.json.access, "admin login (pre-2FA) → tokens");
const adminAccess = r.json?.access;

r = await call("POST", "/auth/2fa/setup", {}, adminAccess);
ok(r.status === 200 && r.json.secret && r.json.otpauthUrl, "2fa/setup → secret+otpauthUrl");
const secret = r.json?.secret;

// wrong code cannot enable
r = await call("POST", "/auth/2fa/enable", { code: "000000" }, adminAccess);
ok(r.status === 401, "2fa/enable wrong code → 401");

let code = await generate({ secret });
r = await call("POST", "/auth/2fa/enable", { code }, adminAccess);
ok(r.status === 200 && r.json.ok, "2fa/enable correct code → ok");

// now admin login demands 2FA
r = await call("POST", "/auth/login", { email: "admin@ashta-eight.com", password: "ChangeMe!2026" });
ok(r.status === 200 && r.json.twoFactorRequired && r.json.challengeId, "admin login → twoFactorRequired");
const challengeId = r.json?.challengeId;
ok(!r.json.access, "2FA-gated login returns NO tokens");

// bad 2FA code
r = await call("POST", "/auth/2fa/verify", { challengeId, code: "123456" });
ok(r.status === 401, "2fa/verify bad code → 401");

// good 2FA code (regenerate — time may have advanced)
code = await generate({ secret });
r = await call("POST", "/auth/2fa/verify", { challengeId, code });
ok(r.status === 200 && r.json.access && r.json.user.role === "administrator", "2fa/verify → tokens");

// 15. OAuth endpoints report unconfigured (no client id set locally)
r = await call("POST", "/auth/google", { idToken: "x" });
ok(r.status === 503, "google (unconfigured) → 503");
r = await call("POST", "/auth/apple", { identityToken: "x" });
ok(r.status === 503, "apple (unconfigured) → 503");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
