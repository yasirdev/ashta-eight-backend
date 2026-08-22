import { Router } from "express";
import { z } from "zod";
import { prismaService } from "../db";
import { asyncHandler, parseBody } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";

// Module 7 — admin analytics. Per CLAUDE.md §6 dashboards use DIRECT SQL
// aggregations. These span every member, so they run on the service role
// (BYPASSRLS) — the enumerated admin-dashboard flow from the frozen contract.
// The API layer restricts access: requireAuth + requireAdmin on every route.
// Status/stage literals below are constants baked into the SQL text; only
// user-supplied values (interval, from, to) cross as bound params.

// Prisma returns BigInt for SUM/COUNT — coerce to a JS number for JSON.
const num = (v: unknown) => (v == null ? 0 : Number(v));

// date_trunc granularity. Whitelisted so an unexpected value can't reach the DB.
const intervalSchema = z.enum(["day", "week", "month"]);

// TIMEZONE-PINNED bucketing. `date_trunc(unit, ts)` on a timestamptz truncates in the DB
// SESSION's timezone — so the SAME data buckets differently per server (dev here runs
// Asia/Karachi, +05): February's bucket comes back as 2026-02-01 00:00+05 =
// 2026-01-31T19:00:00Z, a month early, and a UK business on a US server would see the wrong
// months. Pinning to UTC — `date_trunc(unit, ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` —
// makes every boundary a true UTC instant regardless of where the server runs. (Change the
// two 'UTC' literals to a business zone like 'Europe/London' if day/week boundaries should
// follow local time; month buckets rarely differ.) The admin FE also snaps to the nearest
// month as defence — that snap becomes a harmless no-op on these now-correct boundaries.
// Applied inline in each query below; `${interval}` stays a bound param, only the tz
// literals are SQL.

const rangeQuery = z.object({
  interval: intervalSchema.default("month"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth, requireAdmin);

// GET /admin/analytics/summary — headline tiles.
// MRR = monthly-equivalent recurring price summed over ACTIVE subs (annual/12;
// one_time contributes 0 — it isn't recurring). See PROGRESS_LOG decision.
analyticsRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const [mrrRow] = await prismaService.$queryRaw<{ mrr: bigint }[]>`
      SELECT COALESCE(SUM(
        CASE p.billing_interval
          WHEN 'monthly' THEN p.price_minor
          WHEN 'annual'  THEN p.price_minor / 12
          ELSE 0
        END
      ), 0)::bigint AS mrr
      FROM subscriptions s
      JOIN programmes p ON p.id = s.programme_id
      WHERE s.status = 'active'`;

    const [members] = await prismaService.$queryRaw<
      { active_members: bigint; new_members_30d: bigint }[]
    >`
      SELECT
        (SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE status = 'active')::bigint AS active_members,
        (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '30 days')::bigint AS new_members_30d`;

    const [rev] = await prismaService.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total
      FROM billing_records WHERE status = 'succeeded'`;

    const byProgramme = await prismaService.$queryRaw<
      { programme_id: string; count: bigint }[]
    >`
      SELECT programme_id, COUNT(*)::bigint AS count
      FROM subscriptions WHERE status = 'active'
      GROUP BY programme_id`;

    res.json({
      mrr: num(mrrRow?.mrr),
      activeMembers: num(members?.active_members),
      newMembers30d: num(members?.new_members_30d),
      totalRevenueMinor: num(rev?.total),
      activeSubsByProgramme: byProgramme.map((r) => ({
        programmeId: r.programme_id,
        count: num(r.count),
      })),
    });
  }),
);

// GET /admin/analytics/revenue?interval&from&to — succeeded revenue over time.
analyticsRouter.get(
  "/revenue",
  asyncHandler(async (req, res) => {
    const { interval, from, to } = parseBody(rangeQuery, req.query);
    const fromTs = from ?? null;
    const toTs = to ?? null;
    const rows = await prismaService.$queryRaw<
      { period: Date; revenue_minor: bigint }[]
    >`
      SELECT date_trunc(${interval}, occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period,
             SUM(amount_minor)::bigint AS revenue_minor
      FROM billing_records
      WHERE status = 'succeeded'
        AND (${fromTs}::timestamptz IS NULL OR occurred_at >= ${fromTs}::timestamptz)
        AND (${toTs}::timestamptz IS NULL OR occurred_at < ${toTs}::timestamptz)
      GROUP BY period
      ORDER BY period`;
    res.json({
      series: rows.map((r) => ({ period: r.period, revenueMinor: num(r.revenue_minor) })),
    });
  }),
);

// GET /admin/analytics/subscribers?interval&from&to — gross adds/churn per period.
// newSubs = subs created in the period; churnedSubs = subs that moved to
// canceled/expired in the period (by updated_at); netActive = newSubs - churnedSubs
// (net change that period, not a running total). See PROGRESS_LOG decision.
analyticsRouter.get(
  "/subscribers",
  asyncHandler(async (req, res) => {
    const { interval, from, to } = parseBody(rangeQuery, req.query);
    const fromTs = from ?? null;
    const toTs = to ?? null;
    const rows = await prismaService.$queryRaw<
      { period: Date; new_subs: bigint; churned_subs: bigint }[]
    >`
      WITH adds AS (
        SELECT date_trunc(${interval}, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period, COUNT(*)::bigint AS new_subs
        FROM subscriptions
        WHERE (${fromTs}::timestamptz IS NULL OR created_at >= ${fromTs}::timestamptz)
          AND (${toTs}::timestamptz IS NULL OR created_at < ${toTs}::timestamptz)
        GROUP BY 1
      ),
      churn AS (
        SELECT date_trunc(${interval}, updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period, COUNT(*)::bigint AS churned_subs
        FROM subscriptions
        WHERE status IN ('canceled', 'expired')
          AND (${fromTs}::timestamptz IS NULL OR updated_at >= ${fromTs}::timestamptz)
          AND (${toTs}::timestamptz IS NULL OR updated_at < ${toTs}::timestamptz)
        GROUP BY 1
      )
      SELECT COALESCE(a.period, c.period) AS period,
             COALESCE(a.new_subs, 0) AS new_subs,
             COALESCE(c.churned_subs, 0) AS churned_subs
      FROM adds a
      FULL OUTER JOIN churn c ON a.period = c.period
      ORDER BY period`;
    res.json({
      series: rows.map((r) => {
        const newSubs = num(r.new_subs);
        const churnedSubs = num(r.churned_subs);
        return { period: r.period, newSubs, churnedSubs, netActive: newSubs - churnedSubs };
      }),
    });
  }),
);

// GET /admin/analytics/programmes — per-programme active members + revenue.
analyticsRouter.get(
  "/programmes",
  asyncHandler(async (_req, res) => {
    const rows = await prismaService.$queryRaw<
      { programme_id: string; name: string; active_members: bigint; revenue_minor: bigint }[]
    >`
      SELECT p.id AS programme_id, p.name,
             COALESCE(s.active_members, 0)::bigint AS active_members,
             COALESCE(b.revenue_minor, 0)::bigint AS revenue_minor
      FROM programmes p
      LEFT JOIN (
        SELECT programme_id, COUNT(*) AS active_members
        FROM subscriptions WHERE status = 'active' GROUP BY programme_id
      ) s ON s.programme_id = p.id
      LEFT JOIN (
        SELECT programme_id, SUM(amount_minor) AS revenue_minor
        FROM billing_records WHERE status = 'succeeded' GROUP BY programme_id
      ) b ON b.programme_id = p.id
      ORDER BY p.tier_rank`;
    res.json({
      items: rows.map((r) => ({
        programmeId: r.programme_id,
        name: r.name,
        activeMembers: num(r.active_members),
        revenueMinor: num(r.revenue_minor),
      })),
    });
  }),
);

// GET /admin/analytics/pipeline — coaching leads by stage (R1: 'applied' only,
// query is stage-agnostic so it grows with the enum in R2).
analyticsRouter.get(
  "/pipeline",
  asyncHandler(async (_req, res) => {
    const rows = await prismaService.$queryRaw<{ stage: string; count: bigint }[]>`
      SELECT stage::text AS stage, COUNT(*)::bigint AS count
      FROM coaching_leads
      GROUP BY stage
      ORDER BY stage`;
    res.json({ byStage: rows.map((r) => ({ stage: r.stage, count: num(r.count) })) });
  }),
);
