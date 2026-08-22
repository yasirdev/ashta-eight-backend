import { env, MOCK_OK_ENVS } from "./env";

// THE mock predicate — one function, every integration.
//
// It exists because of a real bug: media.ts owned the check and server.ts re-implemented
// the same comparison, so the two "independent" guards failed TOGETHER — `NODE_ENV=Production`
// (one capital) booted the app and served member media unauthenticated. Zoom and FCM would
// have made four copies, so the predicate is shared and consumers import it.
//
// WHERE THE ACTUAL GUARD LIVES: `env.ts`. A `*_DRIVER=mock` outside dev/test is refused at
// BOOT, for all three integrations at once. This function used to throw per-call instead,
// which was the wrong layer — Zoom's best-effort catch **swallowed** the throw, so a
// misconfigured production silently degraded rather than refusing. Nothing catches a boot
// failure. By the time any of this runs, env.ts has already guaranteed the environment.
//
// The two protections are deliberately DIFFERENT failure modes, not the same one twice:
//   1. Each *_DRIVER is a z.enum defaulting to "live" — production is safe by DEFAULT, and
//      this is what actually protects a deploy that sets nothing.
//   2. NODE_ENV is a z.enum + the boot refinement — an unrecognised value ("Production",
//      "prod", "staging") fails at BOOT rather than being read as "not production".
// Remove either and the other still holds.
export { MOCK_OK_ENVS };

export const mockOkEnv = (): boolean => MOCK_OK_ENVS.has(env.NODE_ENV);

// No throw and no `name`: env.ts already refused every unsafe combination at boot, so a
// mock driver reaching here is, by construction, in an allow-listed environment.
export const mockEnabled = (driver: "live" | "mock" | "local"): boolean => driver === "mock";
