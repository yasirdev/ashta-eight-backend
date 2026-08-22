import { env } from "./env";
import { prismaApp, prismaService } from "./db";
import { logger } from "./logger";
import { createApp } from "./server";
import { initTimeZones } from "./content/timezones";
import { initLocales } from "./i18n";

const server = createApp().listen(env.PORT, () => {
  logger.info(`Ashta Eight API listening on :${env.PORT} (${env.NODE_ENV})`);
});

// Warm the ?tz membership cache from pg_timezone_names off the request path. Not
// required for correctness (isKnownTimeZone lazy-loads on first use), but surfaces a
// boot-time DB problem in the logs immediately rather than on the first dashboard hit.
void initTimeZones();

// Warm the active-locale cache (CR-003). Inert in R1 (only `en` is active) but surfaces
// a boot DB problem and keeps the read off the request path — same posture as above.
void initLocales();

// Keep-alive/headers timeouts slightly above a typical LB idle (S4) so the LB, not
// Node, closes idle upstream sockets — avoids sporadic 502s on AWS ALB.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Graceful shutdown (S4): stop accepting connections, drain in-flight requests,
// close the DB pools, then exit — so a rolling deploy doesn't drop requests.
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  server.close(async () => {
    await Promise.allSettled([prismaApp.$disconnect(), prismaService.$disconnect()]);
    process.exit(0);
  });
  // Hard cap: if drain hangs, exit anyway rather than block the deploy.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
