import type { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";
import { logger } from "./logger";

// Standard error envelope from contracts §3: { error: { code, message } }.
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Wrap async route handlers so thrown/rejected errors reach the error middleware.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
}

// Parse+validate a request body against a schema, throwing a 400 AppError on
// failure. Every endpoint validates its input here (untrusted-input boundary).
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, "invalid_request", z.prettifyError(r.error));
  return r.data;
}

// Shared pagination (contracts §0): ?page (1-based, default 1), ?limit (default
// 20, max 100). Response envelope is { items, page, limit, total }.
export function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, Number.parseInt(String(query.page ?? ""), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? ""), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: "invalid_request", message: z.prettifyError(err) } });
  }
  // body-parser (express.json) rejects a malformed or oversized body BEFORE any route
  // runs, throwing an http-errors object — neither AppError nor ZodError, so it fell
  // through to the 500 below: a client sending bad JSON looked like a server fault, on
  // every endpoint including the unauthenticated ones. Caller error is 4xx.
  // The message is deliberately generic: body-parser's own text can echo a fragment of
  // the request body back to the sender.
  const e = err as { type?: string; status?: number; statusCode?: number };
  const parseStatus = e?.status ?? e?.statusCode;
  if (typeof e?.type === "string" && e.type.startsWith("entity.") && parseStatus) {
    const code = e.type === "entity.too.large" ? "payload_too_large" : "invalid_json";
    const message =
      e.type === "entity.too.large" ? "Request body too large" : "Request body is not valid JSON";
    return res.status(parseStatus).json({ error: { code, message } });
  }
  logger.error({ err }, "unhandled error");
  return res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
}
