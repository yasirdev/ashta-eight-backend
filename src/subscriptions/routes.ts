import { Router } from "express";
import { z } from "zod";
import type { BillingRecord, Programme, Subscription } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parsePagination, parseBody } from "../http";
import { requireAuth } from "../auth/middleware";
import { stripe } from "../stripe";

// Member-facing subscription + billing views. Mounted at /me. Reads run through
// the RLS path (asUser) so a member only ever sees their own rows.
export const subscriptionsRouter = Router();

export const serializeSubscription = (s: Subscription & { programme?: Programme | null }) => ({
  id: s.id,
  status: s.status,
  programmeId: s.programmeId,
  programme: s.programme
    ? { id: s.programme.id, code: s.programme.code, name: s.programme.name, tierRank: s.programme.tierRank }
    : undefined,
  currentPeriodStart: s.currentPeriodStart,
  currentPeriodEnd: s.currentPeriodEnd,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  autoRenew: s.autoRenew,
  cohortBatch: s.cohortBatch,
  createdAt: s.createdAt,
});

// Money history — never expose internal stripe customer/subscription ids.
export const serializeBilling = (b: BillingRecord) => ({
  id: b.id,
  amountMinor: b.amountMinor,
  currency: b.currency,
  status: b.status,
  description: b.description,
  invoiceUrl: b.invoiceUrl,
  programmeId: b.programmeId,
  occurredAt: b.occurredAt,
});

// GET /me/subscription — current + past (newest first).
subscriptionsRouter.get(
  "/subscription",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const items = await asUser(userId, role, (tx) =>
      tx.subscription.findMany({ include: { programme: true }, orderBy: { createdAt: "desc" } }),
    );
    res.json({ items: items.map(serializeSubscription) });
  }),
);

// POST /me/subscription/cancel — cancel at period end. Members can't write the
// subscriptions table (RLS: staff/service only), so we verify ownership via the
// RLS read, then mutate via the service role, then tell Stripe (best-effort).
subscriptionsRouter.post(
  "/subscription/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { subscriptionId } = parseBody(z.object({ subscriptionId: z.uuid() }), req.body);

    const owned = await asUser(userId, role, (tx) =>
      tx.subscription.findFirst({ where: { id: subscriptionId } }),
    );
    if (!owned) throw new AppError(404, "not_found", "Subscription not found");
    if (owned.status !== "active") {
      throw new AppError(409, "not_active", "Only an active subscription can be cancelled");
    }

    const updated = await prismaService.subscription.update({
      where: { id: subscriptionId },
      data: { cancelAtPeriodEnd: true, autoRenew: false },
      include: { programme: true },
    });

    // Stripe is the source of truth for billing — stop the renewal there too.
    if (updated.stripeSubscriptionId) {
      try {
        await stripe().subscriptions.update(updated.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("cancel: Stripe update failed:", (err as Error).message);
      }
    }
    res.json({ subscription: serializeSubscription(updated) });
  }),
);

// GET /me/billing — paginated money history.
subscriptionsRouter.get(
  "/billing",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.billingRecord.findMany({ orderBy: { occurredAt: "desc" }, skip, take: limit }),
        tx.billingRecord.count(),
      ]),
    );
    res.json({ items: items.map(serializeBilling), page, limit, total });
  }),
);

// GET /me/billing/:id/invoice — the Stripe-hosted invoice/receipt URL.
subscriptionsRouter.get(
  "/billing/:id/invoice",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const record = await asUser(userId, role, (tx) =>
      tx.billingRecord.findFirst({ where: { id: String(req.params.id) } }),
    );
    if (!record) throw new AppError(404, "not_found", "Billing record not found");
    if (!record.invoiceUrl) throw new AppError(404, "no_invoice", "No invoice available for this record");
    res.json({ invoiceUrl: record.invoiceUrl });
  }),
);
