// Child-process probe for the G-7 CDN branch of media.thumbnailUrl().
//
// WHY A SEPARATE PROCESS: env.ts parses process.env ONCE at import and caches it, so a
// test running inside the main QA harness cannot reach the `MEDIA_CDN_BASE_URL` branch —
// the module is already loaded with it unset. Spawning with the variable set is the only
// way to exercise the real code path rather than a mirror of it. Same technique the
// boot-guard probes in api.test.ts already use, and for the same reason.
//
// Driven by: `src/qa/api.test.ts` → "with MEDIA_CDN_BASE_URL set, a key resolves to ...".
// Prints `<url>|<null-case>` on one line; the caller asserts on the exact string.

import { thumbnailUrl } from "../media";

const KEY = "images/00000000-0000-0000-0000-0000000000ab.jpg";

async function main() {
  const withKey = await thumbnailUrl(KEY);
  // An unset key must resolve to null, never "" and never a bare key — asserted in the
  // same line so a regression in either branch fails the probe.
  const withoutKey = await thumbnailUrl(null);
  process.stdout.write(`${withKey}|${withoutKey}\n`);
}

main().catch((e) => {
  process.stderr.write(`thumbnail-url probe failed: ${(e as Error).message}\n`);
  process.exit(1);
});
