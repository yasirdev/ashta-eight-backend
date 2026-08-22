import { Router } from "express";
import { z } from "zod";
import type { Notification } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parseBody, parsePagination } from "../http";
import { requireAuth } from "../auth/middleware";

// Module 8 — member notification + device endpoints (contracts §Notifications).
// Device register/delete write via the SERVICE role scoped to the caller's own
// userId (from the verified JWT), so a member can only ever claim/remove a token
// for themselves. RLS can't express this: fcm_token is globally unique, so a
// re-register on a phone that switched accounts must REASSIGN a row the member
// can't see under RLS. Notification reads/mark-read stay on the RLS path (own-only).

const serialize = (n: Notification) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data,
  sentAt: n.sentAt,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

export const notificationsRouter = Router();

// POST /me/devices — register/refresh this device's FCM token (upsert).
notificationsRouter.post(
  "/devices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const { fcmToken, platform } = parseBody(
      z.object({ fcmToken: z.string().min(1), platform: z.enum(["ios", "android"]) }),
      req.body,
    );
    // Reassigns the token to this user if it previously belonged to another
    // account on the same device — the token is per-install, not per-user.
    await prismaService.deviceToken.upsert({
      where: { fcmToken },
      create: { userId, fcmToken, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
    res.json({ ok: true });
  }),
);

// DELETE /me/devices/:fcmToken — remove own device token (logout/uninstall).
notificationsRouter.delete(
  "/devices/:fcmToken",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    // Scoped to userId so a member can only delete their own token.
    await prismaService.deviceToken.deleteMany({
      where: { fcmToken: String(req.params.fcmToken), userId },
    });
    res.json({ ok: true });
  }),
);

// GET /me/notifications — paginated, own-only via RLS. Newest first.
notificationsRouter.get(
  "/notifications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const { items, total } = await asUser(userId, role, async (tx) => {
      const [items, total] = await Promise.all([
        tx.notification.findMany({ orderBy: { createdAt: "desc" }, skip, take: limit }),
        tx.notification.count(),
      ]);
      return { items, total };
    });
    res.json({ items: items.map(serialize), page, limit, total });
  }),
);

// POST /me/notifications/:id/read — mark own notification read (404 if not theirs).
notificationsRouter.post(
  "/notifications/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    await asUser(userId, role, async (tx) => {
      // RLS scopes the update to the caller's rows; a foreign id updates 0 → 404.
      const r = await tx.notification.updateMany({ where: { id }, data: { readAt: new Date() } });
      if (r.count === 0) throw new AppError(404, "not_found", "Notification not found");
    });
    res.json({ ok: true });
  }),
);
