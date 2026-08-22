import { pino } from "pino";
import { env } from "./env";

// Structured JSON logging (Agent 7 finding S2). Replaces bare console.* so a
// 10k-user incident is debuggable — every log line is queryable and, via
// pino-http (see server.ts), carries a per-request id.
export const logger = pino({ level: env.LOG_LEVEL });
