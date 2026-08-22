import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Content, ContentCategory, ContentProgress, ProgressEntry } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parseBody, parsePagination } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";
import {
  IMAGE_OBJECT_KEY_RE,
  createVideoUpload,
  presignDownload,
  presignUpload,
  signPlayback,
  thumbnailUrl,
} from "../media";
import { env } from "../env";
import { notifyNewContent } from "../notifications/service";
import { isKnownTimeZone } from "./timezones";
import { BASE_LOCALIZER, makeLocalizer, type Localizer } from "../i18n";

// Module 5 — content catalogue + media serving. The tier gate is RLS (content_select:
// published AND required_tier_rank <= current_tier_rank()); these routes never leak
// the internal media refs (s3_key / video_ref) to members, and hand out signed URLs
// only through /playback after the RLS read passes.

// Prisma returns BigInt for SUM/COUNT — coerce to a JS number for JSON.
// (Same helper and same reason as analytics/routes.ts:15.)
const num = (v: unknown) => (v == null ? 0 : Number(v));

// Member view: no media refs, no signed url (that's /playback only).
// ASYNC since G-7: `thumbnailUrl` resolves the stored object key to an absolute URL
// (CDN, or a presigned GET in dev). The raw key is never serialized to a member —
// same posture as s3Key/videoRef.
// `loc` is the CR-003 locale seam (default = base pass-through, so a call without it is
// byte-identical to pre-CR-003). `title`/`description` route through it; in R1 there are
// no translation rows so they resolve to the base column. Preload the batch's ids via
// `loc.preload(tx, "content", ids)` before calling this, or the localizer returns base.
const serializeContent = async (c: Content, loc: Localizer = BASE_LOCALIZER) => ({
  id: c.id,
  type: c.type,
  pillar: c.pillar,
  title: loc.text("content", c.id, "title", c.title),
  description: loc.text("content", c.id, "description", c.description),
  requiredTierRank: c.requiredTierRank,
  durationSeconds: c.durationSeconds,
  offlineDownloadable: c.offlineDownloadable,
  weekNumber: c.weekNumber,
  orderIndex: c.orderIndex,
  publishedAt: c.publishedAt,
  thumbnailUrl: await thumbnailUrl(c.thumbnailObjectKey),
});

// Admin view: includes drafts + the internal refs (staff only, via RLS).
const serializeContentAdmin = async (c: Content) => ({
  ...(await serializeContent(c)),
  videoRef: c.videoRef,
  s3Key: c.s3Key,
  thumbnailObjectKey: c.thumbnailObjectKey,
  freePreview: c.freePreview, // CR-001 free set (admins only see/set the flag)
  createdByAdminId: c.createdByAdminId,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

// Browse tile (G-5). The app is given the SLUG and nothing else — never `pillar`/`type`.
// That is the load-bearing part of the design: because the app never learns how a tile
// resolves, promoting one from a saved filter to an explicit curated membership later is
// a server change with no contract change and no app release.
const serializeCategory = (c: ContentCategory, loc: Localizer = BASE_LOCALIZER) => ({
  slug: c.slug,
  label: loc.text("content_category", c.id, "label", c.label),
  iconKey: c.iconKey,
  position: c.position,
});

const serializeProgress = (p: ContentProgress) => ({
  id: p.id,
  contentId: p.contentId,
  status: p.status,
  positionSeconds: p.positionSeconds,
  completedAt: p.completedAt,
  updatedAt: p.updatedAt,
});

const serializeEntry = (e: ProgressEntry) => ({
  id: e.id,
  entryDate: e.entryDate,
  note: e.note,
  metrics: e.metrics,
  createdAt: e.createdAt,
});

// ── Local-day bucketing (?tz) — G-4 / ARCH_SPEC_G4_G8 §1.3 ───────────────────
// A streak and a weekly chart are LOCAL-MIDNIGHT concepts. Admin analytics correctly
// pins its buckets to UTC — that is right for a finance report and wrong here: a member
// in Sydney (+10/+11) has every evening session land on the previous UTC day, so their
// streak and their chart would both be off by one for most of their practice.
//
// The zone is a REQUEST PARAMETER, not a stored column: the device already knows its
// zone authoritatively, and a stored one is wrong the moment the member travels. No
// schema, no settings screen, no "who sets this" question.
//
// WHY ACCEPTING A CLIENT VALUE IS NOT A CLAUDE.md §5 VIOLATION: the rule is that
// SECURITY-BEARING facts are never client-supplied — tier, role, identity. `tz` is none
// of those. It only re-buckets the caller's OWN rows into days for the caller's OWN
// read-only display; the worst a malicious value achieves is a wrong chart for the
// person who sent it. Contrast app.current_tier_rank(), which is DB-authoritative
// precisely BECAUSE it is security-bearing.
const DEFAULT_TZ = "Europe/London";

// Unknown zone ⇒ 400, and deliberately NOT a silent fallback to the default: falling
// back would render a confidently wrong chart that nobody can diagnose. Validated in
// Node BEFORE the value reaches SQL, then bound as a parameter (never interpolated).
//
// Validation is by MEMBERSHIP against PostgreSQL's own `pg_timezone_names` catalog
// (see ./timezones), NOT by name-shape pattern. Membership is exact by construction —
// it is the same set Postgres will accept when the value reaches SQL — so it accepts
// every real name (including slashless aliases like `GMT`, `UTC`, `Zulu`, `EST5EDT`,
// `MST`, `Japan`, `GB` that a shape regex would wrongly reject) while still rejecting
// offset/POSIX forms (`+0530`, `-08`, `GMT+5`) for free, because none of those is a
// catalog name. `GMT+5` in particular is POSIX with an inverted sign and must stay
// rejected. The value is echoed back verbatim, so casing is preserved.
async function resolveTimeZone(raw: unknown): Promise<string> {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TZ;
  const tz = String(raw);
  if (tz.length > 64 || !(await isKnownTimeZone(tz))) {
    throw new AppError(400, "invalid_timezone", `Unknown IANA time zone: ${tz.slice(0, 64)}`);
  }
  return tz;
}

// Pure calendar-date arithmetic on a 'YYYY-MM-DD' string. Date.UTC keeps it away from
// the server's own zone entirely — the local dates come from Postgres, already bucketed.
function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const toMinutes = (seconds: number) => Math.round(seconds / 60);

// ── Member content (/content) ────────────────────────────────────────────────
export const contentRouter = Router();

// GET /content/categories — the Home screen's browse tiles (G-5). Active only, ordered.
// MUST stay above `/:id`, or Express matches "categories" as a content id.
contentRouter.get(
  "/categories",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const loc = await makeLocalizer(req);
    const items = await asUser(userId, role, async (tx) => {
      const rows = await tx.contentCategory.findMany({
        where: { isActive: true },
        orderBy: [{ position: "asc" }, { slug: "asc" }],
      });
      // Preload translations on the RLS session so `translations` RLS (mirrors the
      // parent SELECT) applies. No-op + no query on the base localizer (R1).
      await loc.preload(tx, "content_category", rows.map((r) => r.id));
      return rows;
    });
    res.json({ items: items.map((c) => serializeCategory(c, loc)) });
  }),
);

// GET /content — paginated, tier-filtered by RLS. Optional ?pillar&type&week&category.
contentRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z
      .object({
        pillar: z.enum(["align", "sculpt", "evolve"]).optional(),
        type: z.enum(["video", "audio"]).optional(),
        week: z.coerce.number().int().optional(),
        category: z.string().trim().min(1).max(80).optional(),
      })
      .parse(req.query);

    const loc = await makeLocalizer(req);
    const result = await asUser(userId, role, async (tx) => {
      // ?category resolves SERVER-SIDE (G-5). The app passes back the slug it was given
      // and never learns the filter behind it.
      let category: ContentCategory | null = null;
      if (q.category) {
        category = await tx.contentCategory.findFirst({
          where: { slug: q.category, isActive: true },
        });
        if (!category) throw new AppError(400, "unknown_category", "Unknown content category");
        // A category with NO filter is UNCONFIGURED, not "no filter". Returning
        // everything would be quietly wrong; an empty page is visibly empty, which is
        // the failure mode we want while the client still owes the four definitions.
        if (!category.pillar && !category.type) return { items: [], total: 0 };
      }

      // AND-composed so an explicit ?pillar/?type NARROWS a category rather than
      // silently overriding the server-side resolution.
      const and: Prisma.ContentWhereInput[] = [];
      if (q.pillar) and.push({ pillar: q.pillar });
      if (q.type) and.push({ type: q.type });
      if (q.week !== undefined) and.push({ weekNumber: q.week });
      if (category?.pillar) and.push({ pillar: category.pillar });
      if (category?.type) and.push({ type: category.type });
      const where: Prisma.ContentWhereInput = and.length ? { AND: and } : {};

      const [items, total] = await Promise.all([
        tx.content.findMany({
          where,
          orderBy: [{ weekNumber: "asc" }, { orderIndex: "asc" }, { createdAt: "asc" }],
          skip,
          take: limit,
        }),
        tx.content.count({ where }),
      ]);
      await loc.preload(tx, "content", items.map((c) => c.id));
      return { items, total };
    });

    res.json({
      items: await Promise.all(result.items.map((c) => serializeContent(c, loc))),
      page,
      limit,
      total: result.total,
    });
  }),
);

// GET /content/:id — single item (RLS-gated; 404 if not visible).
contentRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const loc = await makeLocalizer(req);
    const item = await asUser(userId, role, async (tx) => {
      const row = await tx.content.findFirst({ where: { id: String(req.params.id) } });
      if (row) await loc.preload(tx, "content", [row.id]);
      return row;
    });
    if (!item) throw new AppError(404, "not_found", "Content not found");
    res.json({ content: await serializeContent(item, loc) });
  }),
);

// GET /content/:id/playback — short-lived signed URL. RLS is the gate: if the
// asUser read returns the row, the member is entitled. If not, discriminate a
// genuine 404 (missing/unpublished) from a 403 (exists but above their tier).
contentRouter.get(
  "/:id/playback",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const item = await asUser(userId, role, (tx) => tx.content.findFirst({ where: { id } }));

    if (!item) {
      const exists = await prismaService.content.findUnique({ where: { id } });
      if (exists && exists.publishedAt && exists.publishedAt <= new Date()) {
        throw new AppError(403, "tier_gated", "Your tier does not include this content");
      }
      throw new AppError(404, "not_found", "Content not found");
    }

    const signed = item.videoRef
      ? signPlayback(item.videoRef)
      : item.s3Key
        ? await presignDownload(item.s3Key)
        : null;
    if (!signed) throw new AppError(404, "no_media", "Content has no playable media");
    res.json(signed);
  }),
);

// PUT /content/:id/progress — upsert the member's playback state. Verifies the
// content is visible first (RLS), so progress can't be logged against tier-gated
// or unpublished content.
//
// ALSO the sole writer of `content_completions` (G-4). An event is inserted ONLY on the
// TRANSITION: this request sets status='completed' AND the stored row was not already
// 'completed'. Same shape as the `firstPublish` guard below. It happens inside the SAME
// asUser transaction as the upsert, so an event can never be written without the state
// change that justifies it, nor the state change without the event.
//
// A genuine re-watch re-arms the transition naturally (a player reports 'in_progress' as
// it plays from zero, then 'completed' at the end); a client that spams 'completed'
// writes nothing.
//
// 🔒 `completedAt` is SERVER-SET — the API never accepts a client timestamp, and this is
// the security-relevant control here. A backdatable completed_at would let a member (or
// a replayed request) write rows into arbitrary past days, and a FUTURE-dated row would
// corrupt the streak anchor for everyone reading it, including staff. That a member can
// inflate their own streak by driving the state machine by hand is accepted and
// deliberate: content_completions is display-only, nothing entitlement-bearing or
// financial reads it, and RLS confines every row to its owner.
contentRouter.put(
  "/:id/progress",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({
        positionSeconds: z.number().int().min(0),
        status: z.enum(["not_started", "in_progress", "completed"]),
      }),
      req.body,
    );
    const progress = await asUser(userId, role, async (tx) => {
      const content = await tx.content.findFirst({ where: { id } });
      if (!content) throw new AppError(404, "not_found", "Content not found");
      const prior = await tx.contentProgress.findUnique({
        where: { userId_contentId: { userId, contentId: id } },
      });
      const completedAt = body.status === "completed" ? new Date() : null;
      const updated = await tx.contentProgress.upsert({
        where: { userId_contentId: { userId, contentId: id } },
        create: { userId, contentId: id, positionSeconds: body.positionSeconds, status: body.status, completedAt },
        update: { positionSeconds: body.positionSeconds, status: body.status, completedAt },
      });
      if (body.status === "completed" && prior?.status !== "completed") {
        await tx.contentCompletion.create({
          data: {
            userId,
            contentId: id,
            // SNAPSHOT, taken from the row already fetched for the RLS check — no extra
            // query, and (the real reason) so the dashboard aggregate never has to join
            // `content`. A later admin duration edit must not rewrite this member's past.
            durationSeconds: content.durationSeconds,
            // completedAt intentionally omitted → the DB default now() is authoritative.
          },
        });
      }
      return updated;
    });
    res.json({ contentProgress: serializeProgress(progress) });
  }),
);

// ── Member progress views (/me) ──────────────────────────────────────────────
export const meProgressRouter = Router();

// GET /me/progress — paginated playback state across content.
meProgressRouter.get(
  "/progress",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.contentProgress.findMany({ orderBy: { updatedAt: "desc" }, skip, take: limit }),
        tx.contentProgress.count(),
      ]),
    );
    res.json({ items: items.map(serializeProgress), page, limit, total });
  }),
);

// GET /me/dashboard?tz=<IANA> — the Home screen's aggregate (G-4).
//
// WHY AN ENDPOINT AND NOT A FIX TO /me/progress. The Home screen used to page a member's
// entire playback history to render two integers, with an `isPartial` flag to admit the
// numbers were a lower bound whenever it didn't all fit. At the 10,000-user target that
// is the wrong shape twice: unbounded rows over the wire on every app open, and a number
// the client must caveat. This computes where the data is and returns a fixed ~40-row
// payload that is CORRECT rather than partial. /me/progress is unchanged and still
// serves resume state — the Home screen simply stops calling it.
//
// All three aggregates run in ONE asUser transaction on the RLS path (prismaApp), NOT
// prismaService. They read only the caller's own rows, so BYPASSRLS is not warranted and
// content_completions_select confines every row to its owner even if a WHERE clause
// regresses. (admin/analytics is on the service role precisely BECAUSE it is
// cross-member — same reasoning, opposite conclusion. Do not copy its role choice here.)
//
// ⚠️ The aggregate reads content_completions and NOTHING ELSE — it must never join
// `content`. Under RLS, joining would make a tier downgrade, a lapse or an unpublish
// silently SHRINK a member's own history, and an admin's duration edit would rewrite
// their past minutes. Their history is theirs; today's entitlement must not re-filter it.
meProgressRouter.get(
  "/dashboard",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const tz = await resolveTimeZone(req.query.tz);

    const data = await asUser(userId, role, async (tx) => {
      // Local "today" and the Sunday that starts this calendar week, computed IN the
      // query so there is exactly one clock. EXTRACT(DOW) is 0 = Sunday, which is
      // exactly the anchor the design's Sun–Sat axis wants.
      const bounds = await tx.$queryRaw<{ today_local: string; week_start: string }[]>`
        WITH b AS (SELECT (now() AT TIME ZONE ${tz}::text)::date AS today_local)
        SELECT to_char(today_local, 'YYYY-MM-DD') AS today_local,
               to_char(today_local - EXTRACT(DOW FROM today_local)::int, 'YYYY-MM-DD') AS week_start
        FROM b`;

      const totals = await tx.$queryRaw<{ sessions: bigint; seconds: bigint }[]>`
        SELECT COUNT(*)::bigint                           AS sessions,
               COALESCE(SUM(duration_seconds), 0)::bigint AS seconds
        FROM content_completions
        WHERE user_id = app.current_user_id()`;

      // SARGABLE: the range is expressed on the RAW timestamptz column, so the
      // (user_id, completed_at DESC) index is used. The local-midnight boundaries are
      // built once in `w` and converted back to instants here. NEVER write
      // `WHERE (completed_at AT TIME ZONE tz)::date BETWEEN …` — that wraps the indexed
      // column in a function and forces a scan of the member's whole history.
      const week = await tx.$queryRaw<
        { day_local: string; sessions: bigint; seconds: bigint }[]
      >`
        WITH b AS (
          SELECT (now() AT TIME ZONE ${tz}::text)::date AS today_local
        ), w AS (
          SELECT today_local - EXTRACT(DOW FROM today_local)::int AS week_start FROM b
        )
        SELECT to_char((cc.completed_at AT TIME ZONE ${tz}::text)::date, 'YYYY-MM-DD') AS day_local,
               COUNT(*)::bigint                              AS sessions,
               COALESCE(SUM(cc.duration_seconds), 0)::bigint AS seconds
        FROM content_completions cc, w
        WHERE cc.user_id = app.current_user_id()
          AND cc.completed_at >= (w.week_start::timestamp           AT TIME ZONE ${tz}::text)
          AND cc.completed_at <  ((w.week_start + 7)::timestamp     AT TIME ZONE ${tz}::text)
        GROUP BY 1`;

      // Streak, gaps-and-islands. `(a - d) = rn - 1` selects EXACTLY the leading
      // consecutive run: once a gap occurs the deficit becomes strictly positive and,
      // being monotone non-decreasing as you walk backwards, can never return to zero.
      // So the unfiltered COUNT over the whole set IS the current streak — no recursive
      // CTE, no loop, one index scan. It also yields 0 correctly when neither today nor
      // yesterday qualifies (the anchor day is absent, so row 1 already has a deficit).
      // The 400-day bound caps the scan (§1.4); launch is 1 Sep 2026, so it cannot bite
      // before ~Oct 2027.
      const streak = await tx.$queryRaw<{ streak: number; includes_today: boolean }[]>`
        WITH days AS (
          SELECT DISTINCT (completed_at AT TIME ZONE ${tz}::text)::date AS d
          FROM content_completions
          WHERE user_id = app.current_user_id()
            AND completed_at >= now() - interval '400 days'
        ), anchor AS (
          SELECT CASE
                   WHEN EXISTS (SELECT 1 FROM days WHERE d = (now() AT TIME ZONE ${tz}::text)::date)
                     THEN (now() AT TIME ZONE ${tz}::text)::date
                   ELSE (now() AT TIME ZONE ${tz}::text)::date - 1
                 END AS a
        ), run AS (
          SELECT d, ROW_NUMBER() OVER (ORDER BY d DESC) AS rn, a
          FROM days, anchor
          WHERE d <= a
        )
        SELECT COALESCE((SELECT COUNT(*) FILTER (WHERE (a - d) = rn - 1) FROM run), 0)::int AS streak,
               ((SELECT a FROM anchor) = (now() AT TIME ZONE ${tz}::text)::date)            AS includes_today`;

      return { bounds: bounds[0], totals: totals[0], week, streak: streak[0] };
    });

    // EXACTLY 7 entries, always, zero-filled HERE — including days later this week that
    // have not happened yet, and including a member with no history at all. The client
    // must never gap-fill; that is where off-by-one bugs live. `weekday` is an explicit
    // 0..6 (0 = Sunday) so the client binds bars to labels by an integer rather than by
    // re-parsing a date in a locale.
    const weekStart = data.bounds.week_start;
    const byDay = new Map(data.week.map((r) => [r.day_local, r]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const row = byDay.get(date);
      return {
        date,
        weekday: i,
        sessions: num(row?.sessions),
        minutes: toMinutes(num(row?.seconds)),
      };
    });
    const weekSeconds = data.week.reduce((s, r) => s + num(r.seconds), 0);
    const weekSessions = data.week.reduce((s, r) => s + num(r.sessions), 0);

    // The member's own live numbers, and a stale streak is worse than a slow one.
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      // Counts EVENTS, not distinct items — deliberately >= the old client-derived
      // number. See ARCH_SPEC_G4_G8 §6.3: this jumps the day it ships, and is correct.
      sessionsCompleted: num(data.totals.sessions),
      // Minutes, not seconds, rounded ONCE server-side. The client never divides.
      // Content saved without a duration contributes 0, silently — flagged, §6.7.
      minutesCompleted: toMinutes(num(data.totals.seconds)),
      currentStreakDays: data.streak.streak,
      // false ⇒ today is the GRACE day. Not decoration: without it the client cannot
      // tell a 6-day streak that is safe from one that expires at midnight, and any UI
      // wanting to say so would re-derive the rule locally — reintroducing exactly the
      // drift this endpoint exists to remove.
      streakIncludesToday: data.streak.includes_today,
      week: {
        timeZone: tz, // echoed, so a wrong chart is diagnosable from its own payload
        startDate: weekStart,
        endDate: addDays(weekStart, 6),
        sessions: weekSessions,
        // Rounded once from the week's total seconds, so this is the honest aggregate
        // and may differ by a minute from summing the seven rounded day values.
        minutes: toMinutes(weekSeconds),
        days,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

// GET /me/plan/today?tz=<IANA> — the member's position in the 8-week map (G-6).
//
// R1 scope, deliberately narrow: ONE plan, WEEK granularity, read-only. Restarts,
// per-programme plan variants and milestone celebrations are R2.
//
// ⚠️ WEEKLY by default (ARCH_SPEC_G4_G8 §3.0). The design says "TODAY'S", but
// `content.week_number` is the finest granularity the frozen schema has, and SRS /
// RELEASE_SCOPE both say "8-week programme map" and never mention days. A daily map
// would need `content.day_number` and 56 authored slots — additive, and it would change
// only which rows fill `items`, not this endpoint or its response shape. Client Q open.
//
// Completion here is read from content_progress.status, NOT content_completions: the
// ring asks "is this item done" — that is STATE. The dashboard asks "how much did I do
// and when" — that is EVENTS. Same distinction as G-4, applied consistently.
meProgressRouter.get(
  "/plan/today",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const tz = await resolveTimeZone(req.query.tz);
    const loc = await makeLocalizer(req);

    const out = await asUser(userId, role, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new AppError(404, "not_found", "User not found");

      // No plan yet (never subscribed) ⇒ 200 with nulls, NEVER a 404. The Home screen
      // must render without an error path.
      if (!user.planStartedAt) {
        return {
          planStartedAt: null,
          dayNumber: null,
          weekNumber: null,
          isComplete: false,
          items: [] as Content[],
          completedCount: 0,
          totalCount: 0,
          percentComplete: null,
          nextContentId: null,
        };
      }

      // Day count in LOCAL days, computed in SQL so it uses the same clock as /dashboard.
      const rows = await tx.$queryRaw<{ day_number: number }[]>`
        SELECT (
          ((now() AT TIME ZONE ${tz}::text)::date
           - (${user.planStartedAt}::timestamptz AT TIME ZONE ${tz}::text)::date) + 1
        )::int AS day_number`;
      const dayNumber = Math.max(1, rows[0]?.day_number ?? 1);
      const weekNumber = Math.min(8, Math.max(1, Math.floor((dayNumber - 1) / 7) + 1));
      const isComplete = dayNumber > 56;

      // A normal RLS-filtered content read — a member can never see next week's
      // above-tier item, because they cannot see the row.
      const items = await tx.content.findMany({
        where: { weekNumber },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      });
      const progress = items.length
        ? await tx.contentProgress.findMany({ where: { contentId: { in: items.map((i) => i.id) } } })
        : [];
      const done = new Set(
        progress.filter((p) => p.status === "completed").map((p) => p.contentId),
      );
      const completedCount = items.filter((i) => done.has(i.id)).length;
      const next = items.find((i) => !done.has(i.id));
      await loc.preload(tx, "content", items.map((i) => i.id));

      return {
        planStartedAt: user.planStartedAt,
        dayNumber,
        weekNumber,
        isComplete,
        items,
        completedCount,
        totalCount: items.length,
        // NULL when nothing is prescribed — and the contract says the client OMITS the
        // ring when it is null. That preserves, in the contract, the rule Agent 2 applied
        // by hand: a figure the data cannot support is omitted, never faked.
        percentComplete: items.length ? Math.round((completedCount / items.length) * 100) : null,
        nextContentId: next?.id ?? null,
      };
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.json({ ...out, items: await Promise.all(out.items.map((c) => serializeContent(c, loc))) });
  }),
);

// GET /me/progress/entries — paginated self-logged journal/metrics.
meProgressRouter.get(
  "/progress/entries",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.progressEntry.findMany({ orderBy: { entryDate: "desc" }, skip, take: limit }),
        tx.progressEntry.count(),
      ]),
    );
    res.json({ items: items.map(serializeEntry), page, limit, total });
  }),
);

// POST /me/progress/entries — add a journal entry.
meProgressRouter.post(
  "/progress/entries",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const body = parseBody(
      z.object({
        entryDate: z.coerce.date(),
        note: z.string().max(5000).optional(),
        metrics: z.record(z.string(), z.unknown()).optional(),
      }),
      req.body,
    );
    const entry = await asUser(userId, role, (tx) =>
      tx.progressEntry.create({
        data: {
          userId,
          entryDate: body.entryDate,
          note: body.note,
          metrics: (body.metrics ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
    );
    res.status(201).json({ progressEntry: serializeEntry(entry) });
  }),
);

// ── Admin content (/admin) ───────────────────────────────────────────────────
export const adminContentRouter = Router();

// type↔ref invariant (schema: video_ref XOR s3_key): video needs videoRef only,
// audio needs s3Key only.
const contentCreateSchema = z
  .object({
    type: z.enum(["video", "audio"]),
    pillar: z.enum(["align", "sculpt", "evolve"]),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    requiredTierRank: z.number().int().min(0),
    s3Key: z.string().optional(),
    videoRef: z.string().optional(),
    durationSeconds: z.number().int().min(0).optional(),
    weekNumber: z.number().int().min(0).optional(),
    orderIndex: z.number().int().min(0).optional(),
    offlineDownloadable: z.boolean().optional(),
    freePreview: z.boolean().optional(), // CR-001 free set
    // Shape-checked separately by assertImageKey() so the failure carries the specific
    // `invalid_object_key` code rather than the generic Zod envelope.
    thumbnailObjectKey: z.string().max(200).nullable().optional(),
  })
  .refine((v) => (v.type === "video" ? !!v.videoRef && !v.s3Key : !!v.s3Key && !v.videoRef), {
    message: "video requires videoRef only; audio requires s3Key only",
  });

// 🔒 G-7 guard #1 of 2 (the other is CloudFront/OAC, scoped to `images/*`). The bucket
// that holds artwork also holds tier-gated audio, so an unvalidated key here is a route
// to publishing paid audio at a permanent, unauthenticated CDN URL. The key must match
// EXACTLY what presignUpload('image', …) mints — never store a key the API did not
// itself issue the shape for. This also rejects traversal-ish keys like
// `images/../audio/x.mp3`, which is the regression that matters.
function assertImageKey(key: string | null | undefined): void {
  if (key === undefined || key === null) return; // absent = unchanged; null = clear it
  if (!IMAGE_OBJECT_KEY_RE.test(key)) {
    throw new AppError(
      400,
      "invalid_object_key",
      "thumbnailObjectKey must be an images/<uuid>.(jpg|png|webp) key issued by /admin/uploads/presign",
    );
  }
}

// GET /admin/content — paginated incl. drafts. ?pillar&type&published.
adminContentRouter.get(
  "/content",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z
      .object({
        pillar: z.enum(["align", "sculpt", "evolve"]).optional(),
        type: z.enum(["video", "audio"]).optional(),
        published: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const where = {
      pillar: q.pillar,
      type: q.type,
      ...(q.published === "true" ? { publishedAt: { not: null } } : {}),
      ...(q.published === "false" ? { publishedAt: null } : {}),
    };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.content.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
        tx.content.count({ where }),
      ]),
    );
    res.json({
      items: await Promise.all(items.map(serializeContentAdmin)),
      page,
      limit,
      total,
    });
  }),
);

// POST /admin/uploads/presign — 5-min presigned S3 PUT (audio/image/asset).
adminContentRouter.post(
  "/uploads/presign",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        category: z.enum(["audio", "image", "asset"]),
        // Declared upload size (browser File.size), validated + pinned server-side.
        sizeBytes: z.number().int().positive(),
      }),
      req.body,
    );
    res.json(await presignUpload(body.category, body.contentType, body.sizeBytes));
  }),
);

// POST /admin/uploads/video-upload-url — provider direct-upload URL (Mux).
adminContentRouter.post(
  "/uploads/video-upload-url",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ filename: z.string().min(1) }), req.body);
    res.json(await createVideoUpload(body.filename));
  }),
);

// POST /admin/content — save a content reference (draft until published).
adminContentRouter.post(
  "/content",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const body = parseBody(contentCreateSchema, req.body);
    assertImageKey(body.thumbnailObjectKey);
    const created = await asUser(userId, role, (tx) =>
      tx.content.create({ data: { ...body, createdByAdminId: userId } }),
    );
    res.status(201).json({ content: await serializeContentAdmin(created) });
  }),
);

// PATCH /admin/content/:id — partial update.
adminContentRouter.patch(
  "/content/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(5000).nullable().optional(),
        pillar: z.enum(["align", "sculpt", "evolve"]).optional(),
        requiredTierRank: z.number().int().min(0).optional(),
        durationSeconds: z.number().int().min(0).nullable().optional(),
        weekNumber: z.number().int().min(0).nullable().optional(),
        orderIndex: z.number().int().min(0).optional(),
        offlineDownloadable: z.boolean().optional(),
        freePreview: z.boolean().optional(), // CR-001 free set
        s3Key: z.string().optional(),
        videoRef: z.string().optional(),
        // null clears the artwork; a non-null value must be an issued images/ key.
        thumbnailObjectKey: z.string().max(200).nullable().optional(),
      }),
      req.body,
    );
    assertImageKey(body.thumbnailObjectKey);
    const updated = await asUser(userId, role, async (tx) => {
      const exists = await tx.content.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Content not found");
      // The DB CHECK for video_ref XOR s3_key was waived (Module 1) — the app is the
      // ONLY guard, so PATCH must re-assert it on the merged row (type is immutable
      // here, so the surviving ref must match the row's type).
      const nextVideoRef = body.videoRef !== undefined ? body.videoRef : exists.videoRef;
      const nextS3Key = body.s3Key !== undefined ? body.s3Key : exists.s3Key;
      const okRefs =
        exists.type === "video" ? !!nextVideoRef && !nextS3Key : !!nextS3Key && !nextVideoRef;
      if (!okRefs) {
        throw new AppError(400, "invalid_request", `${exists.type} requires exactly its own ref (videoRef XOR s3Key)`);
      }
      return tx.content.update({ where: { id }, data: body });
    });
    res.json({ content: await serializeContentAdmin(updated) });
  }),
);

// POST /admin/content/:id/publish — set/clear published_at.
adminContentRouter.post(
  "/content/:id/publish",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const { publish } = parseBody(z.object({ publish: z.boolean() }), req.body);
    let firstPublish = false;
    const updated = await asUser(userId, role, async (tx) => {
      const exists = await tx.content.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Content not found");
      firstPublish = publish && exists.publishedAt === null;
      return tx.content.update({ where: { id }, data: { publishedAt: publish ? new Date() : null } });
    });
    // new_content push, best-effort, only on the null→published transition. Move
    // this call to a cron to switch from on-publish to batched (env-toggled).
    if (firstPublish && env.NEW_CONTENT_PUSH_ENABLED) {
      notifyNewContent(id).catch((err) => console.error("[notify:new_content] failed", err));
    }
    res.json({ content: await serializeContentAdmin(updated) });
  }),
);

// DELETE /admin/content/:id.
adminContentRouter.delete(
  "/content/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    await asUser(userId, role, async (tx) => {
      const exists = await tx.content.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Content not found");
      await tx.content.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);
