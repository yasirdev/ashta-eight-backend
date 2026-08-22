import type { NotificationType } from "@prisma/client";
import { prismaService } from "../db";
import { sendToTokens, type PushMessage } from "../fcm";

// The one reusable send path (Module 8). Every trigger — renewal sweep, content
// publish, session sweep — funnels through notify(), so "when to send" (the
// trigger) is decoupled from "how to send" (this). Runs on the SERVICE role: this
// is the contract-listed "FCM send-logging" cross-owner flow (contracts §2), and
// crons/publish write notifications on behalf of other users, which RLS forbids
// to the app role.

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Write the in-app notification row (always — it's the member's log regardless of
// push delivery), push to the user's devices, stamp sentAt on success, and prune
// any tokens FCM reports dead. Never throws for delivery problems.
export async function notify(userId: string, input: NotifyInput): Promise<void> {
  const row = await prismaService.notification.create({
    data: { userId, type: input.type, title: input.title, body: input.body, data: input.data },
  });

  const devices = await prismaService.deviceToken.findMany({ where: { userId } });
  if (devices.length === 0) return;

  const msg: PushMessage = {
    title: input.title,
    body: input.body,
    // FCM data values must be strings; always carry the type + notification id.
    data: { type: input.type, notificationId: row.id, ...(input.data ?? {}) },
  };
  const results = await sendToTokens(
    devices.map((d) => d.fcmToken),
    msg,
  );

  const stale = results.filter((r) => r.stale).map((r) => r.token);
  if (stale.length > 0) {
    await prismaService.deviceToken.deleteMany({ where: { fcmToken: { in: stale } } });
  }
  if (results.some((r) => r.ok)) {
    await prismaService.notification.update({ where: { id: row.id }, data: { sentAt: new Date() } });
  }
}

// Fan-out: notify every member ENTITLED to a piece of content (active sub whose
// programme tier grants the content's requiredTierRank). Standalone so the call
// site — inline on publish now, a batched cron later — is the only thing that
// changes to alter cadence.
// ponytail: inline sequential fan-out; move to a queue/cron if launch member
// counts make the publish request slow.
export async function notifyNewContent(contentId: string): Promise<void> {
  const content = await prismaService.content.findUnique({ where: { id: contentId } });
  if (!content || !content.publishedAt) return;

  // Distinct entitled members — MUST mirror the RLS tier gate exactly
  // (app.current_tier_rank in policies.sql), incl. the period guard, so we never
  // push content a stale-'active' member would then get a 403 on.
  const rows = await prismaService.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT s.user_id
    FROM subscriptions s
    JOIN programmes p ON p.id = s.programme_id
    WHERE s.status = 'active'
      AND (s.current_period_end IS NULL OR s.current_period_end > now())
      AND p.tier_rank >= ${content.requiredTierRank}`;

  for (const { user_id } of rows) {
    await notify(user_id, {
      type: "new_content",
      title: "New content available",
      body: content.title,
      data: { contentId: content.id, pillar: content.pillar },
    });
  }
}
