import type { BillingRecord, Prisma, SubscriptionStatus } from "@prisma/client";
import type { CohortBatch } from "@prisma/client";

// Stripe webhook lifecycle handlers (Module 4). Each runs INSIDE the webhook's
// advisory-lock transaction (see payments/routes.ts), so it executes at most once
// per event and commits/rolls back atomically with the ledger gate.
//
// Period fields (current_period_end) and invoice→subscription linkage moved
// across Stripe API versions (top-level → subscription items / invoice.parent),
// so we read them DEFENSIVELY from the raw object with fallbacks rather than
// pinning to one version's TS types. `Obj` is that raw event.data.object.
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toDate = (unix: unknown): Date | null =>
  typeof unix === "number" ? new Date(unix * 1000) : null;

const periodStart = (sub: Obj): Date | null =>
  toDate(sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start);
const periodEnd = (sub: Obj): Date | null =>
  toDate(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);

const asId = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "object" && v ? (v as Obj).id : undefined;

// The subscription id an invoice belongs to, across API shapes.
const invoiceSubId = (inv: Obj): string | undefined =>
  asId(inv.subscription ?? inv.parent?.subscription_details?.subscription ?? inv.lines?.data?.[0]?.subscription);

const asCohort = (v: unknown): CohortBatch | null =>
  v === "batch_1" || v === "batch_2" ? (v as CohortBatch) : null;

// G-6 — anchor the member's 8-week map on their FIRST activation and never again.
// COALESCE is the guard: an upgrade, a pause, a re-subscribe or a Stripe retry all
// re-enter this path, and none of them may reset a member's journey to week 1.
// Deliberately raw SQL rather than a Prisma update — COALESCE makes "write once" an
// atomic property of the statement instead of a read-then-write race between two
// concurrent webhook deliveries. Runs on the service role inside the webhook's
// advisory-lock transaction, so the §trigger guard (which freezes plan_started_at for
// non-staff app-role sessions) does not apply and must not.
export async function anchorPlanStart(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE users SET plan_started_at = COALESCE(plan_started_at, now())
    WHERE id = ${userId}::uuid`;
}

export function mapStripeStatus(s: string): SubscriptionStatus {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "expired";
    default:
      return "incomplete";
  }
}

// customer.subscription.created / customer.subscription.updated → sync status,
// period window, and cancel-at-period-end. Idempotent (keyed on stripe id).
// Non-auto-renew programmes get cancel_at_period_end reflected locally here; the
// Stripe-side enforcement is a best-effort post-commit call in the webhook.
export async function syncSubscription(tx: Prisma.TransactionClient, sub: Obj): Promise<void> {
  const id = asId(sub.id);
  if (!id) return;
  const existing = await tx.subscription.findUnique({ where: { stripeSubscriptionId: id } });
  const programmeId = sub.metadata?.programmeId as string | undefined;
  const programme = programmeId
    ? await tx.programme.findUnique({ where: { id: programmeId } })
    : existing
      ? await tx.programme.findUnique({ where: { id: existing.programmeId } })
      : null;

  const status = mapStripeStatus(String(sub.status));
  const start = periodStart(sub);
  const end = periodEnd(sub);
  // A non-auto-renew programme must not recur → force cancel-at-period-end.
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end) || (programme ? !programme.autoRenew : false);
  // New period? clear the renewal-reminder marker so the next window re-arms.
  const periodAdvanced =
    !!existing?.currentPeriodEnd && !!end && end.getTime() > existing.currentPeriodEnd.getTime();

  if (existing) {
    await tx.subscription.update({
      where: { stripeSubscriptionId: id },
      data: {
        status,
        currentPeriodStart: start ?? existing.currentPeriodStart,
        currentPeriodEnd: end ?? existing.currentPeriodEnd,
        cancelAtPeriodEnd,
        ...(periodAdvanced ? { renewalReminderSentAt: null } : {}),
      },
    });
    if (status === "active") await anchorPlanStart(tx, existing.userId);
    return;
  }
  // First sighting via the subscription event (checkout.session.completed may not
  // have arrived yet). Need our metadata to attribute it.
  const userId = sub.metadata?.userId as string | undefined;
  if (!userId || !programmeId) return;
  await tx.subscription.create({
    data: {
      userId,
      programmeId,
      stripeSubscriptionId: id,
      stripeCustomerId: asId(sub.customer) ?? null,
      status,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd,
      autoRenew: programme?.autoRenew ?? false,
      cohortBatch: asCohort(sub.metadata?.cohortBatch),
    },
  });
  if (status === "active") await anchorPlanStart(tx, userId);
}

// customer.subscription.deleted → ended. Tier drops automatically (RLS
// current_tier_rank counts only active subs).
export async function endSubscription(tx: Prisma.TransactionClient, sub: Obj): Promise<void> {
  const id = asId(sub.id);
  if (!id) return;
  await tx.subscription.updateMany({
    where: { stripeSubscriptionId: id },
    data: { status: "expired", cancelAtPeriodEnd: false },
  });
}

// invoice.paid / invoice.payment_succeeded → the recurring charge. Record billing
// (deduped by invoice id) and advance the period; re-arm the reminder.
export async function recordInvoicePaid(
  tx: Prisma.TransactionClient,
  invoice: Obj,
): Promise<BillingRecord | null> {
  const subId = invoiceSubId(invoice);
  if (!subId) return null;
  const sub = await tx.subscription.findUnique({ where: { stripeSubscriptionId: subId } });
  if (!sub) return null; // subscription not yet known; its create event will seed it

  const invoiceId = asId(invoice.id);
  const already = invoiceId
    ? await tx.billingRecord.findFirst({ where: { stripeInvoiceId: invoiceId } })
    : null;
  let created: BillingRecord | null = null;
  if (!already) {
    const amountMinor = Number(invoice.amount_paid ?? invoice.amount_due ?? 0);
    created = await tx.billingRecord.create({
      data: {
        userId: sub.userId,
        subscriptionId: sub.id,
        programmeId: sub.programmeId,
        amountMinor,
        currency: String(invoice.currency ?? "gbp").toUpperCase(),
        status: "succeeded",
        stripeInvoiceId: invoiceId,
        stripePaymentIntentId: asId(invoice.payment_intent) ?? null,
        invoiceUrl: (invoice.hosted_invoice_url as string) ?? null,
        description: "Ashta Eight renewal",
        occurredAt: new Date(),
      },
    });
  }

  const line = invoice.lines?.data?.[0];
  const start = toDate(line?.period?.start);
  const end = toDate(line?.period?.end);
  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      status: "active",
      ...(start ? { currentPeriodStart: start } : {}),
      ...(end ? { currentPeriodEnd: end } : {}),
      renewalReminderSentAt: null,
    },
  });
  await anchorPlanStart(tx, sub.userId);
  return created;
}

// invoice.payment_failed → past_due. NOTE: RLS current_tier_rank() counts only
// 'active', so past_due drops the member's tier to 0 IMMEDIATELY (no dunning grace)
// — a single failed retry locks a paying member out until payment recovers. Whether
// to grant a grace window (e.g. count past_due as tier-bearing, or delay the status
// flip) is a human product+security decision on the frozen RLS. Flagged, not chosen.
export async function markPaymentFailed(tx: Prisma.TransactionClient, invoice: Obj): Promise<void> {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  await tx.subscription.updateMany({
    where: { stripeSubscriptionId: subId },
    data: { status: "past_due" },
  });
}
