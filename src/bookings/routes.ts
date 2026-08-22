import { Router } from "express";
import { z } from "zod";
import type { Booking, CoachingSlot, LiveCohortSession } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parseBody, parsePagination } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { createMeeting } from "../zoom";
import { sendBookingConfirmation } from "../email";

// Module 6 — coaching bookings + live-cohort sessions + Zoom. Capacity is enforced
// server-side under a row lock via the service role (a member can't see others'
// bookings under RLS, so the count/oversell guard can't live in the member session).
// Zoom is best-effort: the booking/session is the source of truth and is created
// even if the Zoom call is unconfigured (local) or fails — refs backfill later.

const serializeBooking = (b: Booking) => ({
  id: b.id,
  type: b.type,
  status: b.status,
  batch: b.batch,
  coachingSlotId: b.coachingSlotId,
  scheduledStart: b.scheduledStart,
  scheduledEnd: b.scheduledEnd,
  zoomJoinUrl: b.zoomJoinUrl,
  zoomMeetingId: b.zoomMeetingId,
  createdAt: b.createdAt,
});

const serializeSlot = (s: CoachingSlot & { _count?: { bookings: number } }) => ({
  id: s.id,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  capacity: s.capacity,
  status: s.status,
  ...(s._count ? { bookedCount: s._count.bookings } : {}),
});

const serializeSession = (s: LiveCohortSession) => ({
  id: s.id,
  batch: s.batch,
  title: s.title,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  zoomJoinUrl: s.zoomJoinUrl,
});

const durationMinutes = (start: Date, end: Date | null) =>
  end ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)) : 60;

// ── Member (mounted at /) ────────────────────────────────────────────────────
export const bookingsRouter = Router();

// GET /coaching/slots — open slots (RLS: status='open' visible to any member).
bookingsRouter.get(
  "/coaching/slots",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const where = { status: "open" as const, startsAt: { gte: q.from, lte: q.to } };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.coachingSlot.findMany({ where, orderBy: { startsAt: "asc" }, skip, take: limit }),
        tx.coachingSlot.count({ where }),
      ]),
    );
    res.json({ items: items.map(serializeSlot), page, limit, total });
  }),
);

// POST /coaching/bookings — book a slot. Locks the slot, enforces capacity + no
// double-book, then best-effort Zoom link + email confirm.
bookingsRouter.post(
  "/coaching/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const { slotId } = parseBody(z.object({ slotId: z.uuid() }), req.body);

    const booking = await prismaService.$transaction(async (tx) => {
      // Lock the slot row so concurrent bookings serialize on the capacity check.
      await tx.$queryRaw`SELECT id FROM coaching_slots WHERE id = ${slotId}::uuid FOR UPDATE`;
      const slot = await tx.coachingSlot.findUnique({ where: { id: slotId } });
      if (!slot) throw new AppError(404, "not_found", "Slot not found");
      if (slot.status !== "open") throw new AppError(409, "slot_unavailable", "Slot is not open");
      if (slot.startsAt <= new Date()) throw new AppError(409, "slot_past", "Slot has already started");

      const already = await tx.booking.findFirst({
        where: { coachingSlotId: slotId, userId, status: "booked" },
      });
      if (already) throw new AppError(409, "already_booked", "You already hold this slot");

      const count = await tx.booking.count({ where: { coachingSlotId: slotId, status: "booked" } });
      if (count >= slot.capacity) {
        await tx.coachingSlot.update({ where: { id: slotId }, data: { status: "full" } });
        throw new AppError(409, "slot_full", "Slot is fully booked");
      }
      const created = await tx.booking.create({
        data: {
          userId,
          type: "coaching",
          coachingSlotId: slotId,
          scheduledStart: slot.startsAt,
          scheduledEnd: slot.endsAt,
          status: "booked",
        },
      });
      if (count + 1 >= slot.capacity) {
        await tx.coachingSlot.update({ where: { id: slotId }, data: { status: "full" } });
      }
      return created;
    });

    const final = await attachZoomAndConfirm(booking, "Coaching session");
    res.status(201).json({ booking: serializeBooking(final) });
  }),
);

// GET /me/bookings — own bookings (?type coaching|live_cohort).
bookingsRouter.get(
  "/me/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z.object({ type: z.enum(["coaching", "live_cohort"]).optional() }).parse(req.query);
    const where = { type: q.type };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.booking.findMany({ where, orderBy: { scheduledStart: "desc" }, skip, take: limit }),
        tx.booking.count({ where }),
      ]),
    );
    res.json({ items: items.map(serializeBooking), page, limit, total });
  }),
);

// POST /me/bookings/:id/cancel — cancel own booking; free the coaching slot.
bookingsRouter.post(
  "/me/bookings/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const owned = await asUser(userId, role, (tx) => tx.booking.findFirst({ where: { id } }));
    if (!owned) throw new AppError(404, "not_found", "Booking not found");
    if (owned.status !== "booked") throw new AppError(409, "not_cancelable", "Booking cannot be cancelled");

    const updated = await prismaService.$transaction(async (tx) => {
      const b = await tx.booking.update({ where: { id }, data: { status: "canceled" } });
      // Free a coaching slot that had filled (a spot just opened up).
      if (b.coachingSlotId) {
        await tx.coachingSlot.updateMany({
          where: { id: b.coachingSlotId, status: "full" },
          data: { status: "open" },
        });
      }
      return b;
    });
    // ponytail: the Zoom meeting is left to expire on its own (not deleted) — add a
    // best-effort zoom.deleteMeeting if orphaned meetings become a problem.
    res.json({ booking: serializeBooking(updated) });
  }),
);

// GET /live-cohort/sessions — sessions for the member's enrolled batch (RLS-gated:
// visible ⇒ actively enrolled ⇒ join url is included).
bookingsRouter.get(
  "/live-cohort/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const where = { startsAt: { gte: q.from, lte: q.to } };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.liveCohortSession.findMany({ where, orderBy: { startsAt: "asc" }, skip, take: limit }),
        tx.liveCohortSession.count({ where }),
      ]),
    );
    res.json({ items: items.map(serializeSession), page, limit, total });
  }),
);

// Best-effort: create a Zoom meeting for a booking + email the member. The booking
// already exists; failures here (unconfigured locally, or a Zoom outage) don't undo
// it — the refs stay null and can be backfilled.
async function attachZoomAndConfirm(booking: Booking, topic: string): Promise<Booking> {
  let final = booking;
  try {
    const meeting = await createMeeting({
      topic,
      startTime: booking.scheduledStart,
      durationMinutes: durationMinutes(booking.scheduledStart, booking.scheduledEnd),
    });
    final = await prismaService.booking.update({
      where: { id: booking.id },
      data: { zoomMeetingId: meeting.meetingId, zoomJoinUrl: meeting.joinUrl },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("booking: Zoom link not attached:", (err as Error).message);
  }
  try {
    const user = await prismaService.user.findUnique({ where: { id: booking.userId } });
    if (user) {
      await sendBookingConfirmation(user.email, {
        when: final.scheduledStart,
        joinUrl: final.zoomJoinUrl,
        type: final.type,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("booking: confirmation email failed:", (err as Error).message);
  }
  return final;
}

// ── Admin (mounted at /admin) ────────────────────────────────────────────────
export const adminBookingsRouter = Router();

// --- Coaching slots ---
adminBookingsRouter.get(
  "/coaching/slots",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const where = { startsAt: { gte: q.from, lte: q.to } };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.coachingSlot.findMany({
          where,
          orderBy: { startsAt: "asc" },
          skip,
          take: limit,
          include: { _count: { select: { bookings: true } } },
        }),
        tx.coachingSlot.count({ where }),
      ]),
    );
    res.json({ items: items.map(serializeSlot), page, limit, total });
  }),
);

adminBookingsRouter.post(
  "/coaching/slots",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const body = parseBody(
      z
        .object({
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
          capacity: z.number().int().positive().optional(),
        })
        .refine((v) => v.endsAt > v.startsAt, { message: "endsAt must be after startsAt" }),
      req.body,
    );
    const slot = await asUser(userId, role, (tx) =>
      tx.coachingSlot.create({
        data: { ownerId: userId, startsAt: body.startsAt, endsAt: body.endsAt, capacity: body.capacity ?? 1 },
      }),
    );
    res.status(201).json({ slot: serializeSlot(slot) });
  }),
);

adminBookingsRouter.patch(
  "/coaching/slots/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
        capacity: z.number().int().positive().optional(),
        status: z.enum(["open", "full", "closed"]).optional(),
      }),
      req.body,
    );
    const slot = await asUser(userId, role, async (tx) => {
      const exists = await tx.coachingSlot.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Slot not found");
      return tx.coachingSlot.update({ where: { id }, data: body });
    });
    res.json({ slot: serializeSlot(slot) });
  }),
);

adminBookingsRouter.delete(
  "/coaching/slots/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    await asUser(userId, role, async (tx) => {
      const exists = await tx.coachingSlot.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Slot not found");
      const active = await tx.booking.count({ where: { coachingSlotId: id, status: "booked" } });
      if (active > 0) throw new AppError(409, "has_bookings", "Cancel the bookings before deleting the slot");
      await tx.coachingSlot.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);

// --- Live-cohort sessions ---
adminBookingsRouter.get(
  "/live-cohort/sessions",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = z
      .object({
        batch: z.enum(["batch_1", "batch_2"]).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(req.query);
    const where = { batch: q.batch, startsAt: { gte: q.from, lte: q.to } };
    const [items, total] = await asUser(userId, role, (tx) =>
      Promise.all([
        tx.liveCohortSession.findMany({ where, orderBy: { startsAt: "asc" }, skip, take: limit }),
        tx.liveCohortSession.count({ where }),
      ]),
    );
    res.json({ items: items.map(serializeSession), page, limit, total });
  }),
);

adminBookingsRouter.post(
  "/live-cohort/sessions",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const body = parseBody(
      z.object({
        batch: z.enum(["batch_1", "batch_2"]),
        title: z.string().max(200).optional(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date().optional(),
      }),
      req.body,
    );
    const session = await asUser(userId, role, (tx) =>
      tx.liveCohortSession.create({
        data: { batch: body.batch, title: body.title, startsAt: body.startsAt, endsAt: body.endsAt },
      }),
    );
    // Best-effort shared Zoom meeting for the session (staff write → service role).
    let final = session;
    try {
      const meeting = await createMeeting({
        topic: body.title ?? `Live Cohort ${body.batch}`,
        startTime: session.startsAt,
        durationMinutes: durationMinutes(session.startsAt, session.endsAt),
      });
      final = await prismaService.liveCohortSession.update({
        where: { id: session.id },
        data: { zoomMeetingId: meeting.meetingId, zoomJoinUrl: meeting.joinUrl },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("live-cohort: Zoom link not attached:", (err as Error).message);
    }
    res.status(201).json({ session: { ...serializeSession(final), zoomMeetingId: final.zoomMeetingId } });
  }),
);

adminBookingsRouter.patch(
  "/live-cohort/sessions/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({
        batch: z.enum(["batch_1", "batch_2"]).optional(),
        title: z.string().max(200).nullable().optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().nullable().optional(),
      }),
      req.body,
    );
    const session = await asUser(userId, role, async (tx) => {
      const exists = await tx.liveCohortSession.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Session not found");
      return tx.liveCohortSession.update({ where: { id }, data: body });
    });
    res.json({ session: serializeSession(session) });
  }),
);

adminBookingsRouter.delete(
  "/live-cohort/sessions/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    await asUser(userId, role, async (tx) => {
      const exists = await tx.liveCohortSession.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Session not found");
      await tx.liveCohortSession.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);
