import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import type { BillingRecord, CohortBatch, Programme } from "@prisma/client";
import { prismaApp, prismaService } from "../db";
import { env } from "../env";
import { BASE_LOCALIZER, makeLocalizer, type Localizer } from "../i18n";
import { AppError, asyncHandler, parseBody } from "../http";
import { requireAuth } from "../auth/middleware";
import { stripe } from "../stripe";
import { sendReceipt } from "../email";
import {
  anchorPlanStart,
  endSubscription,
  markPaymentFailed,
  recordInvoicePaid,
  syncSubscription,
} from "./lifecycle";

// ─── Programmes (public catalogue) ───────────────────────────────────────────
export const programmesRouter = Router();

// stripePriceId is internal — never exposed to clients.
// `features` (G-1) is ALWAYS present and NEVER null: the DB column is NOT NULL
// DEFAULT '{}', so an unset list serialises as [] structurally rather than by
// serializer convention. Order is as stored — never re-sorted, never de-duplicated.
// Exported for the admin copy editor (admin/routes.ts), which wraps rather than
// re-declares it so the two shapes cannot drift.
// `loc` is the CR-003 locale seam (default = base pass-through, so a call without it —
// e.g. the admin copy editor, which must see the base source — is byte-identical to
// pre-CR-003). `name`/`description` route through it; in R1 there are no translation
// rows so they resolve to the base column. Preload the batch's ids first.
export const serializeProgramme = (p: Programme, loc: Localizer = BASE_LOCALIZER) => ({
  id: p.id,
  code: p.code,
  name: loc.text("programme", p.id, "name", p.name),
  description: loc.text("programme", p.id, "description", p.description),
  tierRank: p.tierRank,
  priceMinor: p.priceMinor,
  currency: p.currency,
  billingInterval: p.billingInterval,
  autoRenew: p.autoRenew,
  features: p.features,
});

// Public reads run as ashta_app with NO session GUC → RLS `programmes_select`
// (is_active OR is_staff) shows active rows only. Filter is also explicit. The
// `translations` preload runs on the same public `prismaApp` session, so its RLS
// (mirrors `programmes_select`) applies. No-op + no query on the base localizer (R1).
programmesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const loc = await makeLocalizer(req);
    const items = await prismaApp.programme.findMany({
      where: { isActive: true },
      orderBy: { tierRank: "asc" },
    });
    await loc.preload(prismaApp, "programme", items.map((p) => p.id));
    res.json({ items: items.map((p) => serializeProgramme(p, loc)) });
  }),
);

programmesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const loc = await makeLocalizer(req);
    const programme = await prismaApp.programme.findFirst({
      where: { id: String(req.params.id), isActive: true },
    });
    if (!programme) throw new AppError(404, "not_found", "Programme not found");
    await loc.preload(prismaApp, "programme", [programme.id]);
    res.json({ programme: serializeProgramme(programme, loc) });
  }),
);

// ─── Payments ────────────────────────────────────────────────────────────────
export const paymentsRouter = Router();

const checkoutSchema = z.object({
  programmeId: z.uuid(),
  cohortBatch: z.enum(["batch_1", "batch_2"]).optional(),
});

// POST /payments/checkout-session — create an EXTERNAL Stripe Checkout session.
// The member is redirected to Stripe-hosted checkout (no card data ever touches
// us). The subscription is created/activated later by the webhook, not here —
// members never write the subscriptions table (RLS: staff/service only).
paymentsRouter.post(
  "/checkout-session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(checkoutSchema, req.body);
    // Read the programme via the RLS path so an INACTIVE programme can't be bought.
    const programme = await prismaApp.programme.findFirst({
      where: { id: body.programmeId, isActive: true },
    });
    if (!programme) throw new AppError(404, "not_found", "Programme not found");
    if (!programme.stripePriceId) {
      throw new AppError(409, "not_purchasable", "Programme has no Stripe price configured");
    }
    const user = await prismaService.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });

    // Metadata is the ONLY link back to our user/programme in the webhook — set
    // it on both the session and the resulting subscription.
    const metadata = {
      userId: user.id,
      programmeId: programme.id,
      cohortBatch: body.cohortBatch ?? "",
    };
    let session;
    try {
      session = await stripe().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: programme.stripePriceId, quantity: 1 }],
        customer_email: user.email,
        client_reference_id: user.id,
        success_url: `${env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: env.STRIPE_CANCEL_URL,
        metadata,
        subscription_data: { metadata },
      });
    } catch (err) {
      if (err instanceof AppError) throw err; // 503 stripe_unconfigured
      // eslint-disable-next-line no-console
      console.error("stripe checkout.sessions.create failed:", err);
      throw new AppError(502, "stripe_error", "Could not create checkout session");
    }
    res.json({ checkoutUrl: session.url, sessionId: session.id });
  }),
);

// ─── Webhook ─────────────────────────────────────────────────────────────────
// Mounted with express.raw() in server.ts — constructEvent needs the RAW body to
// verify the signature. Returns 400 on a bad/absent signature (never 500).
// Idempotent via the webhook_events ledger AND idempotent side effects.
export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "stripe_unconfigured", "Stripe webhook secret not configured");
  }
  const sig = req.headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(
      req.body as Buffer,
      sig as string,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    // Signature verification failed — reject, do not process.
    return res.status(400).json({ error: { code: "invalid_signature", message: "Bad signature" } });
  }

  // Process the whole event inside ONE transaction serialized on the event id by
  // a Postgres advisory xact lock. This closes the concurrent-duplicate window:
  // Stripe can deliver the same event twice at once, and both would otherwise pass
  // a plain processed_at check and double-insert billing. With the lock, the second
  // delivery blocks until the first commits, then sees processed_at set and acks as
  // a duplicate. On failure the txn rolls back wholesale (no event row, no side
  // effects) so a Stripe retry re-runs cleanly. Correctness comes from this gate,
  // not from the audit ledger. The lock key derives from the event id (unrelated
  // events hash apart; a rare hash collision just briefly serialises two — harmless).
  let duplicate = false;
  // A billing record created by THIS event → send exactly one receipt post-commit.
  // Null on replay (duplicate gate returns early) or non-payment events, so no
  // double receipts on Stripe retries.
  let newBilling: BillingRecord | null = null;
  await prismaService.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`;
    const seen = await tx.webhookEvent.findUnique({ where: { stripeEventId: event.id } });
    if (seen?.processedAt) {
      duplicate = true;
      return;
    }
    await tx.webhookEvent.upsert({
      where: { stripeEventId: event.id },
      create: {
        stripeEventId: event.id,
        type: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
    const obj = event.data.object as unknown as Record<string, unknown>;
    switch (event.type) {
      case "checkout.session.completed":
        newBilling = await activateFromCheckout(tx, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await syncSubscription(tx, obj);
        break;
      case "customer.subscription.deleted":
        await endSubscription(tx, obj);
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded":
        newBilling = await recordInvoicePaid(tx, obj);
        break;
      case "invoice.payment_failed":
        await markPaymentFailed(tx, obj);
        break;
      // Unhandled types are recorded (audit) + acked; no side effects.
    }
    await tx.webhookEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() },
    });
  });

  // Post-commit, best-effort: enforce non-auto-renew on Stripe (set
  // cancel_at_period_end) when a subscription first appears. Done OUTSIDE the DB
  // lock (it's a network call) and idempotent, so a retry is harmless. Local
  // state already reflects this via syncSubscription; this makes Stripe stop
  // billing the 3 non-auto-renew programmes. FLAGGED: needs real Stripe keys to
  // verify — with dummy keys it logs and continues.
  if (!duplicate && event.type === "customer.subscription.created") {
    await enforceNoAutoRenew(event.data.object as unknown as Record<string, unknown>);
  }

  // Receipt email (Module 9), post-commit + best-effort: only for a billing record
  // this event actually created, so at-most-once per charge (Stripe retries hit the
  // duplicate gate and never re-create). Never fails the webhook ack.
  if (newBilling) {
    const b: BillingRecord = newBilling;
    // Fully best-effort: the billing already committed, so a lookup/send hiccup must
    // not 500 the ack (a retry would just hit the duplicate gate and skip the receipt).
    try {
      const user = await prismaService.user.findUnique({ where: { id: b.userId } });
      if (user) {
        await sendReceipt(user.email, {
          amountMinor: b.amountMinor,
          currency: b.currency,
          description: b.description ?? "Ashta Eight subscription",
          invoiceUrl: b.invoiceUrl,
          occurredAt: b.occurredAt,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[receipt] post-commit send failed for billing ${b.id}:`, err);
    }
  }

  res.json(duplicate ? { received: true, duplicate: true } : { received: true });
}

async function enforceNoAutoRenew(sub: Record<string, unknown>): Promise<void> {
  const id = typeof sub.id === "string" ? sub.id : undefined;
  const programmeId = (sub.metadata as Record<string, string> | undefined)?.programmeId;
  if (!id || !programmeId || sub.cancel_at_period_end === true) return;
  const programme = await prismaService.programme.findUnique({ where: { id: programmeId } });
  if (!programme || programme.autoRenew) return;
  try {
    await stripe().subscriptions.update(id, { cancel_at_period_end: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`enforceNoAutoRenew: Stripe update failed for ${id}:`, (err as Error).message);
  }
}

// Activate the paid subscription and grant tier. Tier is granted automatically:
// RLS app.current_tier_rank() counts an ACTIVE subscription (period_end NULL = no
// expiry) — so status='active' IS the grant. Period dates + expiry are Module 4.
// Runs inside the webhook's serialized transaction (`tx`), so it never opens its
// own — the caller's advisory lock + processed_at gate guarantee it executes at
// most once per event. Side effects are also independently idempotent (sub keyed
// on unique stripeSubscriptionId; billing deduped by invoice) for defence in depth.
async function activateFromCheckout(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session,
): Promise<BillingRecord | null> {
  const md = session.metadata ?? {};
  const userId = md.userId;
  const programmeId = md.programmeId;
  const stripeSubscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!userId || !programmeId || !stripeSubscriptionId) {
    // Missing our metadata → not a session we created; nothing to activate.
    return null;
  }
  const stripeCustomerId =
    typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
  const cohortBatch =
    md.cohortBatch === "batch_1" || md.cohortBatch === "batch_2"
      ? (md.cohortBatch as CohortBatch)
      : null;
  const programme = await tx.programme.findUnique({ where: { id: programmeId } });
  const amountMinor = session.amount_total ?? programme?.priceMinor ?? 0;
  const stripeInvoiceId =
    typeof session.invoice === "string" ? session.invoice : (session.invoice?.id ?? null);
  const stripePaymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  // Idempotent on replay: keyed by the unique stripeSubscriptionId.
  const sub = await tx.subscription.upsert({
    where: { stripeSubscriptionId },
    create: {
      userId,
      programmeId,
      status: "active",
      stripeSubscriptionId,
      stripeCustomerId,
      cohortBatch,
      autoRenew: programme?.autoRenew ?? false,
    },
    update: { status: "active", stripeCustomerId },
  });

  // G-6: this is the member's first transition to active, so anchor the 8-week map.
  // COALESCE-guarded inside the helper — a Stripe replay cannot reset it.
  await anchorPlanStart(tx, userId);

  // Record billing ONLY when we have the invoice id to dedupe on. When it's
  // absent here, the first `invoice.paid` (which always carries the invoice id)
  // records it instead — this avoids the double-bill window where a null-invoice
  // checkout row can't be deduped against the later invoice.paid row.
  if (stripeInvoiceId) {
    const already = await tx.billingRecord.findFirst({ where: { stripeInvoiceId } });
    if (!already) {
      return tx.billingRecord.create({
        data: {
          userId,
          subscriptionId: sub.id,
          programmeId,
          amountMinor,
          currency: programme?.currency ?? "GBP",
          status: "succeeded",
          stripeInvoiceId,
          stripePaymentIntentId,
          description: programme?.name ?? "Ashta Eight subscription",
          occurredAt: new Date(),
        },
      });
    }
  }
  return null;
}
