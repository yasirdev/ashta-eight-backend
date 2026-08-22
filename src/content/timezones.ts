import { prismaApp } from "../db";
import { logger } from "../logger";

// ── ?tz membership validation (G-4 / MEDIUM-4) ───────────────────────────────
// A member's `?tz` must be validated against EXACTLY the set of names PostgreSQL
// will accept, because Postgres is what ultimately receives the value (as a bound
// parameter) in `now() AT TIME ZONE $tz`. The authority for that set is Postgres's
// own catalog view `pg_timezone_names` — not a name-shape regex and not ICU's
// `Intl` accepted set, both of which are a DIFFERENT set from Postgres's:
//
//   - The old name-shape regex (HIGH-1 fix) OVER-rejected: it demanded an
//     `Area/Location` slash and so 400'd 44 slashless names Postgres accepts —
//     `GMT`, `UTC`, `Zulu`, `Universal`, `Greenwich`, `EST5EDT`, `MST`, and country
//     aliases `Japan`, `GB`, `Singapore`, `Israel`, `Turkey`, … `GMT` is the
//     member-plausible one: Android's `TimeZone.getDefault().getID()` returns the
//     literal "GMT" on a device with no zone set, which `flutter_timezone` passes
//     through verbatim, and the contract forbids a silent fallback — so that would
//     be a hard 400 on the app-open endpoint.
//   - ICU's `Intl` set OVER-accepts: it takes ISO-8601 OFFSET identifiers (`+0530`,
//     `-08`, `+05:30`) Postgres rejects, which is the original HIGH-1 500.
//
// Membership against `pg_timezone_names` is exact by construction: it accepts every
// real name (including the 44) and rejects the offset/POSIX forms for free, because
// none of them is a catalog name (`GMT+5` is POSIX — Postgres would parse it, with
// an INVERTED sign, but it is not in the catalog, so it is refused at the door, which
// is what we want). Postgres resolves zone names case-insensitively, so the set is
// stored lowercased and lookups are lowercased.

// Queried once and cached (~598 strings on PG 16). `pg_timezone_names` is a system
// catalog present in EVERY database — including a fresh/empty one and the QA harness
// DB — so this read never depends on our own schema having been migrated.
let zoneCache: Set<string> | null = null;
let inflight: Promise<Set<string> | null> | null = null;

// Boot-failure fallback. If the catalog read fails (DB down at startup) we serve
// membership from this small hardcoded IANA set rather than silently accepting
// EVERYTHING (a wrong chart for every member) or rejecting everything (a dead Home
// screen for every member). It covers UTC/GMT plus the common device zones; anything
// outside it 400s until a lazy reload succeeds and swaps in the full catalog set.
// This is a degraded mode, not the steady state — the endpoints already need the DB
// to serve any data, so a DB that is down at boot is typically back before the first
// authenticated dashboard request lands.
const FALLBACK_ZONE_NAMES = [
  "UTC",
  "GMT",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Istanbul",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Calcutta",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Perth",
  "Pacific/Auckland",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
];
const FALLBACK_ZONES = new Set(FALLBACK_ZONE_NAMES.map((n) => n.toLowerCase()));

async function loadZones(): Promise<Set<string>> {
  const rows = await prismaApp.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`;
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

// Load-once with retry-on-failure: a failed attempt clears `inflight` so the NEXT
// caller re-attempts (rather than caching the failure), and until one succeeds we
// answer from FALLBACK_ZONES.
async function ensureZones(): Promise<Set<string> | null> {
  if (zoneCache) return zoneCache;
  if (!inflight) {
    inflight = loadZones()
      .then((set) => {
        zoneCache = set;
        logger.info({ count: set.size }, "loaded time zone names from pg_timezone_names");
        return set;
      })
      .catch((err) => {
        inflight = null; // allow a later request to retry the catalog read
        logger.error(
          { err },
          "failed to load pg_timezone_names — validating ?tz against the fallback IANA set until a reload succeeds",
        );
        return null;
      });
  }
  return inflight;
}

// Eagerly warm the cache at process start (index.ts). Not required for correctness —
// `isKnownTimeZone` lazy-loads on first use, which is what the QA harness relies on —
// but it surfaces a boot-time DB problem in the logs and pays the read cost off the
// request path.
export async function initTimeZones(): Promise<void> {
  await ensureZones();
}

// True iff `name` is a zone PostgreSQL will accept. Case-insensitive.
export async function isKnownTimeZone(name: string): Promise<boolean> {
  const key = name.toLowerCase();
  const set = await ensureZones();
  return (set ?? FALLBACK_ZONES).has(key);
}
