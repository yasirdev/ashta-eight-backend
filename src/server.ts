import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { asyncHandler, errorHandler } from "./http";
import { prismaApp } from "./db";
import { logger } from "./logger";
import { authLimiter, globalLimiter, publicWriteLimiter } from "./rate-limit";
import { authRouter, meRouter } from "./auth/routes";
import { paymentsRouter, programmesRouter, stripeWebhookHandler } from "./payments/routes";
import { subscriptionsRouter } from "./subscriptions/routes";
import { adminContentRouter, contentRouter, meProgressRouter } from "./content/routes";
import { adminFaqsRouter, adminPagesRouter, faqsRouter, pagesRouter } from "./pages/routes";
import { adminBookingsRouter, bookingsRouter } from "./bookings/routes";
import { analyticsRouter } from "./analytics/routes";
import { notificationsRouter } from "./notifications/routes";
import { adminManagementRouter } from "./admin/routes";
import { adminLeadsRouter, leadsRouter } from "./leads/routes";
import { meRecommendationRouter, recommendationRouter } from "./recommendation/routes";
import { env } from "./env";
import { MOCK_PREFIX, mockMediaAllowed } from "./media";
import { mockMediaRouter } from "./mock-media";
import { LOCAL_MEDIA_PREFIX, localEnabled, localMediaRouter } from "./local-media";

export function createApp() {
  const app = express();
  // CORS pinned to the known browser origins (S5). Native app requests carry no
  // Origin header and are unaffected; unlisted browser origins get no CORS headers.
  app.use(cors({ origin: [env.APP_BASE_URL, env.ADMIN_ORIGIN], credentials: false }));
  // Structured per-request logging with an auto request id (S2).
  app.use(pinoHttp({ logger }));

  // Stripe webhook MUST see the raw body to verify the signature, so it is
  // mounted with express.raw BEFORE the global JSON parser consumes the body.
  app.post(
    "/payments/webhook",
    express.raw({ type: "application/json" }),
    asyncHandler(stripeWebhookHandler),
  );

  // Mock media origin (S3 + Stream stand-in). Mounted BEFORE express.json() because it
  // takes raw binary bodies, and ONLY via mockMediaAllowed() — an allow-list over an
  // enum'd NODE_ENV. It serves bytes with no auth, so it must be unreachable anywhere
  // but dev/test. The predicate lives in media.ts so this cannot drift from the check
  // media.ts itself makes (re-implementing it here is exactly how the old pair of
  // "independent" guards ended up failing together on `NODE_ENV=Production`).
  if (mockMediaAllowed()) {
    app.use(MOCK_PREFIX, mockMediaRouter());
  }

  // Local media origin (CR-007): media stored on and served by this server. Mounted BEFORE
  // express.json() because the upload route takes raw binary bodies. Only mounted when
  // MEDIA_DRIVER=local; the signed-URL check is inside the router.
  if (localEnabled()) {
    app.use(LOCAL_MEDIA_PREFIX, localMediaRouter());
  }

  app.use(express.json());

  // Liveness + readiness (S3). Mounted BEFORE the global limiter so load-balancer
  // health checks are never throttled. Readiness pings the DB the app actually uses.
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get(
    "/health/ready",
    asyncHandler(async (_req, res) => {
      try {
        await prismaApp.$queryRaw`SELECT 1`;
        res.json({ ready: true });
      } catch {
        res.status(503).json({ error: { code: "not_ready", message: "Database unavailable" } });
      }
    }),
  );

  // Global rate-limit backstop (S1) for everything below (the Stripe webhook is
  // mounted above express.json, so it is exempt — Stripe retries must not be throttled).
  app.use(globalLimiter);

  app.use("/auth", authLimiter, authRouter);
  app.use("/me", meRouter);
  app.use("/me", subscriptionsRouter);
  app.use("/programmes", programmesRouter);
  app.use("/payments", paymentsRouter);
  app.use("/content", contentRouter);
  app.use("/me", meProgressRouter);
  app.use("/admin", adminContentRouter);
  app.use("/pages", pagesRouter); // CR-008 public info pages (privacy/terms/about)
  app.use("/faqs", faqsRouter); // CR-008 public Help-Center FAQs
  app.use("/admin", adminPagesRouter); // CR-008 admin CRUD
  app.use("/admin", adminFaqsRouter);
  app.use("/", bookingsRouter);
  app.use("/admin", adminBookingsRouter);
  app.use("/admin/analytics", analyticsRouter);
  app.use("/me", notificationsRouter);
  app.use("/admin", adminManagementRouter);
  app.use("/admin/leads", adminLeadsRouter);
  app.use("/leads", publicWriteLimiter, leadsRouter);
  app.use("/recommendation", publicWriteLimiter, recommendationRouter);
  app.use("/me", meRecommendationRouter);

  // 404 + error envelope (contracts §3).
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Not found" } }));
  app.use(errorHandler);
  return app;
}
