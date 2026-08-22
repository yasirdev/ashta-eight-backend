import type { Subscription } from "@prisma/client";
import { prismaService } from "../db";
import { env } from "../env";
import { notify } from "../notifications/service";
import { sendRenewalReminderEmail } from "../email";

// Renewal-reminder sweep (cron; a listed service-role flow). Finds AUTO-RENEWING
// subscriptions whose current period ends within RENEWAL_REMINDER_DAYS and that
// haven't been reminded this period, claims each atomically (renewalReminderSentAt
// guard → once per period, safe under concurrent runs), then sends BOTH the push
// (Module 8) and the email (Module 9). renewalReminderSentAt is cleared when the
// period advances (see lifecycle.ts), so the next window re-arms. Only auto-renew,
// non-cancelling subs get a "you'll be charged" reminder; non-auto-renew ones won't
// renew, so nothing to remind.
async function enqueueRenewalReminder(sub: Subscription): Promise<void> {
  await notify(sub.userId, {
    type: "renewal_reminder",
    title: "Your subscription renews soon",
    body: `Your membership renews on ${sub.currentPeriodEnd?.toISOString() ?? "soon"}.`,
    data: { subscriptionId: sub.id },
  });
  // Email counterpart (best-effort; sendRenewalReminderEmail never throws).
  const user = await prismaService.user.findUnique({ where: { id: sub.userId } });
  const programme = await prismaService.programme.findUnique({ where: { id: sub.programmeId } });
  if (user) {
    await sendRenewalReminderEmail(user.email, {
      periodEnd: sub.currentPeriodEnd,
      programmeName: programme?.name ?? "Ashta Eight",
    });
  }
}

export async function sweepRenewalReminders(now: Date = new Date()): Promise<number> {
  const windowEnd = new Date(now.getTime() + env.RENEWAL_REMINDER_DAYS * 86_400_000);
  const due = await prismaService.subscription.findMany({
    where: {
      status: "active",
      autoRenew: true,
      cancelAtPeriodEnd: false,
      renewalReminderSentAt: null,
      currentPeriodEnd: { gt: now, lte: windowEnd },
    },
  });

  let sent = 0;
  for (const sub of due) {
    // Atomic claim: only the run that flips the null marker sends it.
    const claimed = await prismaService.subscription.updateMany({
      where: { id: sub.id, renewalReminderSentAt: null },
      data: { renewalReminderSentAt: now },
    });
    if (claimed.count === 1) {
      await enqueueRenewalReminder(sub);
      sent++;
    }
  }
  return sent;
}

// Runnable directly for cron: `tsx src/subscriptions/reminders.ts`.
if (require.main === module) {
  sweepRenewalReminders()
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(`renewal reminders sent: ${n}`);
      return prismaService.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
