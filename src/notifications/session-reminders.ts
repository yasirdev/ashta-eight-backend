import { prismaService } from "../db";
import { env } from "../env";
import { notify } from "./service";

// Coaching session-reminder sweep (cron; a listed service-role flow). Finds
// booked coaching sessions starting within the lead window that haven't been
// reminded, claims each atomically on `reminderSentAt` (the marker the Architect
// pre-built for exactly this), and pushes via notify(). Lead time is an env knob
// (SESSION_REMINDER_LEAD_HOURS) so cadence changes without touching code.
//
// Live-cohort batch sessions are intentionally NOT swept here — that table has no
// reminderSentAt marker; wiring it later is a thin notify() call once the recurring
// -class cadence is decided (see PROGRESS_LOG / plan).

export async function sweepSessionReminders(now: Date = new Date()): Promise<number> {
  const windowEnd = new Date(now.getTime() + env.SESSION_REMINDER_LEAD_HOURS * 3_600_000);
  const due = await prismaService.booking.findMany({
    where: {
      type: "coaching",
      status: "booked",
      reminderSentAt: null,
      scheduledStart: { gt: now, lte: windowEnd },
    },
  });

  let sent = 0;
  for (const b of due) {
    // Atomic claim: only the run that flips the null marker sends it.
    const claimed = await prismaService.booking.updateMany({
      where: { id: b.id, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (claimed.count !== 1) continue;
    await notify(b.userId, {
      type: "session_reminder",
      title: "Your coaching session is coming up",
      body: `Starts ${b.scheduledStart.toISOString()}`,
      data: {
        bookingId: b.id,
        scheduledStart: b.scheduledStart.toISOString(),
        ...(b.zoomJoinUrl ? { joinUrl: b.zoomJoinUrl } : {}),
      },
    });
    sent++;
  }
  return sent;
}

// Runnable directly for cron: `tsx src/notifications/session-reminders.ts`.
if (require.main === module) {
  sweepSessionReminders()
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(`session reminders sent: ${n}`);
      return prismaService.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
