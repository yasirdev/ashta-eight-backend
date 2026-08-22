import { Router } from "express";
import { z } from "zod";
import type { Prisma, Programme } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { env } from "../env";
import { AppError, asyncHandler, parseBody, parsePagination } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { stripe } from "../stripe";
import { serializeBilling, serializeSubscription } from "../subscriptions/routes";
import { serializeProgramme } from "../payments/routes";

// Module 10 — Admin client & subscription management + billing/refund
// (contracts §Admin — clients & subscriptions). All reads/writes run through the
// RLS staff path (asUser → is_staff() policies grant cross-client access), so RLS
// stays the floor and requireAdmin is the API gate on top. Stripe mutations are
// BEST-EFFORT (local DB is the source of truth; Stripe skipped/tolerated when
// unconfigured or failing) — same posture as Module 4. FLAGGED FOR HUMAN HARDENING.

export const adminManagementRouter = Router();
adminManagementRouter.use(requireAuth, requireAdmin);

const num = (v: unknown) => (v == null ? 0 : Number(v));
const stripeOn = () => !!env.STRIPE_SECRET_KEY;

// Shared client `user` shape (notes served separately, only on the profile view).
const serializeClientUser = (u: {
  id: string;
  email: string;
  displayName: string | null;
  phone: string | null;
  role: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date | null;
  disabledAt?: Date | null;
  deletedAt?: Date | null;
}) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  phone: u.phone,
  role: u.role,
  emailVerifiedAt: u.emailVerifiedAt,
  createdAt: u.createdAt,
  lastActiveAt: u.lastActiveAt,
  // Account status for the admin client list/detail (enable/disable/delete controls).
  disabledAt: u.disabledAt ?? null,
  deletedAt: u.deletedAt ?? null,
  status: u.deletedAt ? "deleted" : u.disabledAt ? "disabled" : "active",
});

// ─── Programmes (copy editor — G-1 / ARCH_SPEC_G1 §5) ────────────────────────
// A COPY editor, not a tier manager. Deliberately no POST and no DELETE, and the write
// surface stops at {name, description, features} — these are copy. Everything excluded
// has a blast radius far outside G-1 and each is a separately-designed piece of work:
//   tierRank        — the entitlement axis. app.current_tier_rank() and every content
//                     RLS decision route through it; editing it silently re-grades what
//                     existing paying members can see.
//   priceMinor/currency/billingInterval/stripePriceId
//                   — the price a member is CHARGED lives in Stripe. Changing priceMinor
//                     without moving the Stripe Price desynchronises the displayed price
//                     from the charged one: a live mis-selling risk on the most
//                     commercial screen in the app.
//   isActive        — hides a programme from the catalogue and from purchase. A
//                     deactivation decision, not a copy edit.
//   code            — stable slug, referenced by the seed upsert and analytics.
// This is an Architect decision on the record, not an oversight.

// Admin shape = the public one plus the two internal fields staff legitimately need.
// Wraps the public serializer so the member-visible shape cannot drift out from under it.
const serializeProgrammeAdmin = (p: Programme) => ({
  ...serializeProgramme(p),
  isActive: p.isActive,
  stripePriceId: p.stripePriceId,
});

// The API ceiling over the DB floor (the `programmes_features_valid` CHECK). Blanks are
// REJECTED, never silently dropped — a silently-dropped row makes the admin think they
// saved five features and shipped four.
const featuresSchema = z.array(z.string().trim().min(1).max(120)).max(8);

const patchProgrammeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  features: featuresSchema.optional(),
});

// GET /admin/programmes — paginated, INCLUDING inactive (staff see them via RLS).
adminManagementRouter.get(
  "/programmes",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.programme.findMany({ orderBy: { tierRank: "asc" }, skip, take: limit }),
        tx.programme.count(),
      ]),
    );
    res.json({ items: items.map(serializeProgrammeAdmin), page, limit, total });
  }),
);

// PATCH /admin/programmes/:id — copy only. `features` is REPLACE-WHOLE-ARRAY: sending it
// replaces the list in order, omitting it leaves it untouched. No per-index patching and
// no reorder endpoint — the admin form posts the four inputs it rendered, so one save is
// one statement and one audit event and can never leave a half-edited card in front of a
// paying customer. Routed through the RLS path (asUser + staff GUCs) so programmes_write
// is the floor — NOT prismaService; there is no cross-owner flow here.
adminManagementRouter.patch(
  "/programmes/:id",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(patchProgrammeSchema, req.body);
    const updated = await asUser(userId, role, async (tx) => {
      const exists = await tx.programme.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Programme not found");
      return tx.programme.update({ where: { id }, data: body });
    });
    res.json({ programme: serializeProgrammeAdmin(updated) });
  }),
);

// ─── Clients ─────────────────────────────────────────────────────────────────

// GET /admin/clients — paginated roster with tier / current status / total spend.
// One indexed SQL pass (no N+1); filters applied in SQL so pagination is correct.
adminManagementRouter.get(
  "/clients",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = parseBody(
      z.object({
        search: z.string().trim().min(1).optional(),
        tier: z.coerce.number().int().optional(),
        status: z.enum(["active", "past_due", "canceled", "expired", "paused", "incomplete"]).optional(),
      }),
      req.query,
    );
    const search = q.search ?? null;
    const like = search ? `%${search}%` : null;
    const tier = q.tier ?? null;
    const status = q.status ?? null;

    const { rows, total } = await asUser(userId, role, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          display_name: string | null;
          email: string;
          phone: string | null;
          created_at: Date;
          last_active_at: Date | null;
          tier: number;
          status: string | null;
          total_spend: bigint;
        }[]
      >`
        WITH client AS (
          SELECT u.id, u.display_name, u.email, u.phone, u.created_at, u.last_active_at,
            COALESCE((SELECT MAX(p.tier_rank) FROM subscriptions s JOIN programmes p ON p.id = s.programme_id
                      WHERE s.user_id = u.id AND s.status = 'active'
                        AND (s.current_period_end IS NULL OR s.current_period_end > now())), 0) AS tier,
            (SELECT s.status::text FROM subscriptions s WHERE s.user_id = u.id
             ORDER BY s.created_at DESC LIMIT 1) AS status,
            COALESCE((SELECT SUM(amount_minor) FROM billing_records
                      WHERE user_id = u.id AND status = 'succeeded'), 0)::bigint AS total_spend
          FROM users u
          WHERE u.role = 'member'
        )
        SELECT * FROM client
        WHERE (${like}::text IS NULL OR email ILIKE ${like} OR display_name ILIKE ${like} OR phone ILIKE ${like})
          AND (${tier}::int IS NULL OR tier = ${tier}::int)
          AND (${status}::text IS NULL OR status = ${status}::text)
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${skip}`;

      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM users u
        WHERE u.role = 'member'
          AND (${like}::text IS NULL OR u.email ILIKE ${like} OR u.display_name ILIKE ${like} OR u.phone ILIKE ${like})
          AND (${tier}::int IS NULL OR COALESCE((SELECT MAX(p.tier_rank) FROM subscriptions s JOIN programmes p ON p.id = s.programme_id
                WHERE s.user_id = u.id AND s.status = 'active'
                  AND (s.current_period_end IS NULL OR s.current_period_end > now())), 0) = ${tier}::int)
          AND (${status}::text IS NULL OR (SELECT s.status::text FROM subscriptions s WHERE s.user_id = u.id
                ORDER BY s.created_at DESC LIMIT 1) = ${status}::text)`;
      return { rows, total: num(count) };
    });

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        email: r.email,
        phone: r.phone,
        tier: r.tier,
        status: r.status ?? "none",
        joinDate: r.created_at,
        lastActive: r.last_active_at,
        totalSpendMinor: num(r.total_spend),
      })),
      page,
      limit,
      total,
    });
  }),
);

// GET /admin/clients/:id — full profile (incl. admin-private notes).
adminManagementRouter.get(
  "/clients/:id",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const data = await asUser(userId, role, async (tx) => {
      const user = await tx.user.findFirst({ where: { id } });
      if (!user) return null;
      const [subscriptions, billing, contentProgress, entriesLogged, lastEntry] = await Promise.all([
        tx.subscription.findMany({ where: { userId: id }, include: { programme: true }, orderBy: { createdAt: "desc" } }),
        tx.billingRecord.findMany({ where: { userId: id }, orderBy: { occurredAt: "desc" } }),
        tx.contentProgress.groupBy({ by: ["status"], where: { userId: id }, _count: true }),
        tx.progressEntry.count({ where: { userId: id } }),
        tx.progressEntry.findFirst({ where: { userId: id }, orderBy: { entryDate: "desc" } }),
      ]);
      return { user, subscriptions, billing, contentProgress, entriesLogged, lastEntry };
    });
    if (!data) throw new AppError(404, "not_found", "Client not found");
    const byStatus = Object.fromEntries(data.contentProgress.map((g) => [g.status, g._count]));
    res.json({
      user: serializeClientUser(data.user),
      subscriptions: data.subscriptions.map(serializeSubscription),
      billing: data.billing.map(serializeBilling),
      progressSummary: {
        contentCompleted: byStatus["completed"] ?? 0,
        contentInProgress: byStatus["in_progress"] ?? 0,
        entriesLogged: data.entriesLogged,
        lastEntryDate: data.lastEntry?.entryDate ?? null,
      },
      notes: data.user.notes,
    });
  }),
);

// PATCH /admin/clients/:id — edit phone + admin-private notes.
adminManagementRouter.patch(
  "/clients/:id",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({ phone: z.string().max(40).nullable().optional(), notes: z.string().max(5000).nullable().optional() }),
      req.body,
    );
    const user = await asUser(userId, role, async (tx) => {
      const exists = await tx.user.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Client not found");
      return tx.user.update({ where: { id }, data: body });
    });
    res.json({ user: serializeClientUser(user) });
  }),
);

// ─── Subscription controls ───────────────────────────────────────────────────

// Load a subscription that belongs to the given client, else 404.
async function ownedSub(tx: Prisma.TransactionClient, clientId: string, subscriptionId: string) {
  const sub = await tx.subscription.findFirst({ where: { id: subscriptionId, userId: clientId } });
  if (!sub) throw new AppError(404, "not_found", "Subscription not found for this client");
  return sub;
}

// POST /admin/clients/:id/subscription/change — upgrade/downgrade the client's
// current active subscription to another programme.
adminManagementRouter.post(
  "/clients/:id/subscription/change",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const clientId = String(req.params.id);
    const { programmeId } = parseBody(z.object({ programmeId: z.string().uuid() }), req.body);
    const result = await asUser(userId, role, async (tx) => {
      const target = await tx.programme.findFirst({ where: { id: programmeId } });
      if (!target || !target.isActive) throw new AppError(409, "programme_unavailable", "Target programme not available");
      // Change the client's current active sub (most recent active).
      const sub = await tx.subscription.findFirst({
        where: { userId: clientId, status: "active" },
        orderBy: { createdAt: "desc" },
      });
      if (!sub) throw new AppError(409, "no_active_subscription", "Client has no active subscription to change");
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { programmeId, autoRenew: target.autoRenew },
        include: { programme: true },
      });
      return {
        updated,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        priceId: target.stripePriceId,
        autoRenew: target.autoRenew,
      };
    });
    // Best-effort Stripe price swap (proration default). Local row is source of truth.
    // Also reconcile cancel_at_period_end with the target's auto-renew, matching M4:
    // a non-auto-renew target must stop re-billing on Stripe.
    if (stripeOn() && result.stripeSubscriptionId && result.priceId) {
      try {
        const s = await stripe().subscriptions.retrieve(result.stripeSubscriptionId);
        const itemId = s.items.data[0]?.id;
        if (itemId) {
          await stripe().subscriptions.update(result.stripeSubscriptionId, {
            items: [{ id: itemId, price: result.priceId }],
            cancel_at_period_end: !result.autoRenew,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[admin] stripe subscription change failed:", (err as Error).message);
      }
    }
    res.json({ subscription: serializeSubscription(result.updated) });
  }),
);

// POST /admin/clients/:id/subscription/pause — pause billing (Stripe
// pause_collection) → status 'paused' (tier drops to 0 automatically via RLS).
adminManagementRouter.post(
  "/clients/:id/subscription/pause",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const clientId = String(req.params.id);
    const { subscriptionId } = parseBody(z.object({ subscriptionId: z.string().uuid() }), req.body);
    const result = await asUser(userId, role, async (tx) => {
      const sub = await ownedSub(tx, clientId, subscriptionId);
      if (sub.status !== "active") throw new AppError(409, "not_active", "Only an active subscription can be paused");
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "paused" },
        include: { programme: true },
      });
      return { updated, stripeSubscriptionId: sub.stripeSubscriptionId };
    });
    if (stripeOn() && result.stripeSubscriptionId) {
      try {
        await stripe().subscriptions.update(result.stripeSubscriptionId, { pause_collection: { behavior: "void" } });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[admin] stripe pause failed:", (err as Error).message);
      }
    }
    res.json({ subscription: serializeSubscription(result.updated) });
  }),
);

// POST /admin/clients/:id/subscription/cancel — cancel at period end.
adminManagementRouter.post(
  "/clients/:id/subscription/cancel",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const clientId = String(req.params.id);
    const { subscriptionId } = parseBody(z.object({ subscriptionId: z.string().uuid() }), req.body);
    const result = await asUser(userId, role, async (tx) => {
      const sub = await ownedSub(tx, clientId, subscriptionId);
      if (!["active", "past_due", "paused"].includes(sub.status)) {
        throw new AppError(409, "not_cancelable", "Subscription is not in a cancelable state");
      }
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true },
        include: { programme: true },
      });
      return { updated, stripeSubscriptionId: sub.stripeSubscriptionId };
    });
    if (stripeOn() && result.stripeSubscriptionId) {
      try {
        await stripe().subscriptions.update(result.stripeSubscriptionId, { cancel_at_period_end: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[admin] stripe cancel failed:", (err as Error).message);
      }
    }
    res.json({ subscription: serializeSubscription(result.updated) });
  }),
);

// ─── Client account controls: enable / disable / force-logout / soft-delete ────
// These write another user's account-state columns (disabled_at/deleted_at) and
// revoke their sessions — a cross-owner flow, so they run on the SERVICE role
// (RLS + the §trigger block the app role). requireAdmin is the API gate.
//
// SAFETY (load-bearing): the target must be a `member`, never staff, and never the
// caller themselves — so an admin can't disable/delete the admin team or lock
// themselves out. Fetched on the service role to see the target regardless of state.
async function requireControllableClient(clientId: string, callerId: string) {
  const target = await prismaService.user.findUnique({ where: { id: clientId } });
  if (!target || target.role !== "member") {
    // 404, not 403: don't reveal that a staff id exists via this member-only surface.
    throw new AppError(404, "not_found", "Client not found");
  }
  if (target.id === callerId) {
    throw new AppError(403, "forbidden", "You cannot perform this action on your own account");
  }
  return target;
}

async function revokeAllSessions(tx: Prisma.TransactionClient, userId: string) {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// POST /admin/clients/:id/disable — block login (reversible) + revoke sessions.
adminManagementRouter.post(
  "/clients/:id/disable",
  asyncHandler(async (req, res) => {
    const clientId = String(req.params.id);
    await requireControllableClient(clientId, req.auth!.userId);
    const updated = await prismaService.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: clientId }, data: { disabledAt: new Date() } });
      await revokeAllSessions(tx, clientId);
      return u;
    });
    res.json({ client: serializeClientUser(updated) });
  }),
);

// POST /admin/clients/:id/enable — clear the disable block (login allowed again).
adminManagementRouter.post(
  "/clients/:id/enable",
  asyncHandler(async (req, res) => {
    const clientId = String(req.params.id);
    await requireControllableClient(clientId, req.auth!.userId);
    const updated = await prismaService.user.update({
      where: { id: clientId },
      data: { disabledAt: null },
    });
    res.json({ client: serializeClientUser(updated) });
  }),
);

// POST /admin/clients/:id/logout — force logout: revoke all sessions. Login still allowed.
adminManagementRouter.post(
  "/clients/:id/logout",
  asyncHandler(async (req, res) => {
    const clientId = String(req.params.id);
    await requireControllableClient(clientId, req.auth!.userId);
    await prismaService.$transaction((tx) => revokeAllSessions(tx, clientId));
    res.json({ ok: true });
  }),
);

// POST /admin/clients/:id/delete — soft-delete: mark deleted + revoke sessions. Login blocked.
adminManagementRouter.post(
  "/clients/:id/delete",
  asyncHandler(async (req, res) => {
    const clientId = String(req.params.id);
    await requireControllableClient(clientId, req.auth!.userId);
    const updated = await prismaService.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
      await revokeAllSessions(tx, clientId);
      return u;
    });
    res.json({ client: serializeClientUser(updated) });
  }),
);

// ─── Billing + refund ────────────────────────────────────────────────────────

// GET /admin/billing — paginated money history (?from&to&programmeId).
adminManagementRouter.get(
  "/billing",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = parseBody(
      z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        programmeId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const where: Prisma.BillingRecordWhereInput = {
      ...(q.programmeId ? { programmeId: q.programmeId } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
    };
    const { items, total } = await asUser(userId, role, async (tx) => {
      const [items, total] = await Promise.all([
        tx.billingRecord.findMany({
          where,
          orderBy: { occurredAt: "desc" },
          skip,
          take: limit,
          include: { user: { select: { id: true, displayName: true, email: true } } },
        }),
        tx.billingRecord.count({ where }),
      ]);
      return { items, total };
    });
    // Admin-only client attribution (contract §3, 2026-07-16 extension). serializeBilling
    // stays shared with /me/billing (which must NOT carry another user's identity), so the
    // `user` field is attached here, on the admin path only.
    res.json({
      items: items.map((b) => ({ ...serializeBilling(b), user: b.user })),
      page,
      limit,
      total,
    });
  }),
);

// GET /admin/billing/:id/invoice — Stripe hosted invoice/receipt URL.
adminManagementRouter.get(
  "/billing/:id/invoice",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const rec = await asUser(userId, role, (tx) => tx.billingRecord.findFirst({ where: { id } }));
    if (!rec) throw new AppError(404, "not_found", "Billing record not found");
    if (!rec.invoiceUrl) throw new AppError(404, "no_invoice", "No invoice URL for this record");
    res.json({ invoiceUrl: rec.invoiceUrl });
  }),
);

// POST /admin/billing/:id/refund — Stripe refund (full if amount omitted).
// R1 model: ONE refund per charge. Any refund marks the original 'refunded', so
// the succeeded-only guard blocks a second refund → no over-refund. Full → mark the
// original refunded; partial → mark the original refunded AND append a negative
// ledger row (append-only history). NEVER stores card data. Incremental multi-part
// refunds on one charge are a human-hardening enhancement (needs a refunded-to-date
// field), flagged.
adminManagementRouter.post(
  "/billing/:id/refund",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const { amountMinor } = parseBody(z.object({ amountMinor: z.number().int().positive().optional() }), req.body);
    const rec = await asUser(userId, role, (tx) => tx.billingRecord.findFirst({ where: { id } }));
    if (!rec) throw new AppError(404, "not_found", "Billing record not found");
    // succeeded-only ⇒ a charge can be refunded at most once (blocks over-refund).
    if (rec.status !== "succeeded") throw new AppError(409, "not_refundable", "Only a not-yet-refunded succeeded charge can be refunded");
    if (amountMinor && amountMinor > rec.amountMinor) throw new AppError(400, "amount_too_large", "Refund exceeds charge");
    const isFull = !amountMinor || amountMinor === rec.amountMinor;

    // When Stripe is configured we MUST actually refund — resolve a target from the
    // payment_intent/charge, falling back to the invoice (subscription-mode first
    // charges leave payment_intent null on the checkout row). No target ⇒ 409, never
    // a fake success. When Stripe is NOT configured (local/dev) the refund is
    // local-only + best-effort (documented; verified with real keys in hardening).
    if (stripeOn()) {
      let paymentIntent = rec.stripePaymentIntentId;
      let charge = rec.stripeChargeId;
      if (!paymentIntent && !charge && rec.stripeInvoiceId) {
        try {
          const inv = (await stripe().invoices.retrieve(rec.stripeInvoiceId)) as {
            payment_intent?: string | { id: string } | null;
            charge?: string | { id: string } | null;
          };
          paymentIntent = (typeof inv.payment_intent === "string" ? inv.payment_intent : inv.payment_intent?.id) ?? null;
          charge = charge ?? (typeof inv.charge === "string" ? inv.charge : inv.charge?.id) ?? null;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[admin] stripe invoice lookup failed:", (err as Error).message);
        }
      }
      if (!paymentIntent && !charge) {
        throw new AppError(409, "no_refund_target", "No Stripe charge found to refund for this record");
      }
      try {
        await stripe().refunds.create({
          ...(paymentIntent ? { payment_intent: paymentIntent } : { charge: charge! }),
          ...(isFull ? {} : { amount: amountMinor }),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[admin] stripe refund failed:", (err as Error).message);
        throw new AppError(502, "refund_failed", "Stripe refund failed");
      }
    }

    const out = await asUser(userId, role, async (tx) => {
      // Mark the original refunded either way — this is the guard against a second refund.
      const original = await tx.billingRecord.update({ where: { id: rec.id }, data: { status: "refunded" } });
      if (isFull) return original;
      // Partial: append a negative refund row for the immutable ledger.
      return tx.billingRecord.create({
        data: {
          userId: rec.userId,
          subscriptionId: rec.subscriptionId,
          programmeId: rec.programmeId,
          amountMinor: -amountMinor!,
          currency: rec.currency,
          status: "refunded",
          description: `Partial refund of ${rec.id}`,
          occurredAt: new Date(),
        },
      });
    });
    res.json({ billing: serializeBilling(out) });
  }),
);
