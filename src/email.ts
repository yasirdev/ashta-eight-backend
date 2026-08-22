import { env } from "./env";

// Module 9 — email delivery via Mailchimp Transactional (Mandrill) HTTP API. Raw
// fetch, no SDK (matches the Stripe/Mux/Zoom/FCM style). Lazy: when unconfigured
// it LOGS instead of sending, so local dev + the M2/M6 smoke flows stay testable
// with no creds and callers never change. All sends are best-effort — email must
// never fail the caller's request/webhook. FLAGGED FOR HUMAN HARDENING (deliver-
// ability, SPF/DKIM, and moving copy into Mailchimp templates are the human pass;
// the Zapier-webhook route is a one-function swap if the client prefers it).

export function emailConfigured(): boolean {
  return !!(env.MAILCHIMP_TRANSACTIONAL_API_KEY && env.EMAIL_FROM);
}

interface EmailContent {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// The single transport every helper funnels through.
async function send(msg: EmailContent): Promise<void> {
  if (!emailConfigured()) {
    // No mail provider configured, so print the body to the server console —
    // otherwise a local reset is untestable, the code being unreachable.
    // Guarded on NODE_ENV: a production box with mail misconfigured must NOT
    // spill reset codes into its logs.
    // eslint-disable-next-line no-console
    console.log(
      env.NODE_ENV === "production"
        ? `[email:stub] to=${msg.to} subject=${JSON.stringify(msg.subject)}`
        : `[email:stub] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`,
    );
    return;
  }
  try {
    const res = await fetch(env.MAILCHIMP_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: env.MAILCHIMP_TRANSACTIONAL_API_KEY,
        message: {
          from_email: env.EMAIL_FROM,
          from_name: env.EMAIL_FROM_NAME,
          to: [{ email: msg.to, type: "to" }],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        },
      }),
    });
    // Mandrill returns 200 with a per-recipient status array; a rejected/invalid
    // send still 200s with status "rejected"/"invalid", and auth errors are non-2xx.
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[email] send failed to=${msg.to} status=${res.status}`);
      return;
    }
    const body = (await res.json()) as Array<{ status: string; reject_reason?: string }>;
    const bad = Array.isArray(body) && body.find((r) => r.status === "rejected" || r.status === "invalid");
    if (bad) {
      // eslint-disable-next-line no-console
      console.error(`[email] not delivered to=${msg.to} status=${bad.status} reason=${bad.reject_reason ?? "-"}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[email] send error to=${msg.to}`, err);
  }
}

const money = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toFixed(2)}`;

// ── Transactional emails (callers unchanged from the Module 2/6 stubs) ──

export async function sendAuthEmail(
  to: string,
  kind: "verify_email" | "reset_password",
  token: string,
): Promise<void> {
  // Password reset is a CODE the member types into the app; email verification
  // is still a link they tap. Sending a link for the reset would be unusable —
  // the app collects six digits, not a URL.
  if (kind === "reset_password") {
    await send({
      to,
      subject: "Your Ashta Eight password reset code",
      text: `Your password reset code is ${token}. It expires in 1 hour.\nIf you didn't ask for this, ignore this email.`,
      html: `<p>Your password reset code is <strong style="font-size:20px;letter-spacing:2px">${token}</strong></p><p>It expires in 1 hour. If you didn't ask for this, ignore this email.</p>`,
    });
    return;
  }
  const link = `${env.APP_BASE_URL}/verify-email?token=${token}`;
  await send({
    to,
    subject: "Verify your Ashta Eight email",
    text: `Tap to verify your email:\n${link}`,
    html: `<p>Tap to verify your email:</p><p><a href="${link}">${link}</a></p>`,
  });
}

export async function sendBookingConfirmation(
  to: string,
  detail: { when: Date; joinUrl: string | null; type: string },
): Promise<void> {
  const label = detail.type === "coaching" ? "coaching session" : "live cohort session";
  const join = detail.joinUrl ? `\nJoin: ${detail.joinUrl}` : "";
  await send({
    to,
    subject: `Your Ashta Eight ${label} is booked`,
    text: `Your ${label} is confirmed for ${detail.when.toISOString()}.${join}`,
  });
}

// ── Module 9 additions ──

// Receipt for a completed payment (Mailchimp "receipts" trigger). Sent post-commit,
// once per billing record (the webhook's duplicate gate guarantees at-most-once).
export async function sendReceipt(
  to: string,
  detail: { amountMinor: number; currency: string; description: string; invoiceUrl: string | null; occurredAt: Date },
): Promise<void> {
  const amount = money(detail.amountMinor, detail.currency);
  const invoice = detail.invoiceUrl ? `\nInvoice: ${detail.invoiceUrl}` : "";
  await send({
    to,
    subject: `Your Ashta Eight receipt — ${amount}`,
    text: `Thank you. We received ${amount} for ${detail.description} on ${detail.occurredAt.toISOString()}.${invoice}`,
  });
}

// Renewal reminder (email counterpart to the Module 8 push; both fire from the
// renewal sweep). "You'll be charged" — auto-renew subs only.
export async function sendRenewalReminderEmail(
  to: string,
  detail: { periodEnd: Date | null; programmeName: string },
): Promise<void> {
  const when = detail.periodEnd ? detail.periodEnd.toISOString() : "soon";
  await send({
    to,
    subject: "Your Ashta Eight membership renews soon",
    text: `Your ${detail.programmeName} membership renews on ${when}. No action needed to continue.`,
  });
}
