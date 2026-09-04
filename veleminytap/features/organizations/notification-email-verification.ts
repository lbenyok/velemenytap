import "server-only";

import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Round-3 finding R3-03: sends the one-click confirmation link for a
 * newly-requested notification_email. The recipient is the CANDIDATE
 * address itself, not an existing org member -- that's the entire point,
 * proving whoever set this address can actually read mail sent to it.
 *
 * Returns whether the email was actually sent (false if Resend isn't
 * configured or the send itself failed) so the caller can tell the user
 * their request didn't go anywhere, rather than claiming success for an
 * email that was never sent.
 */
export async function sendNotificationEmailConfirmation(params: {
  email: string;
  token: string;
  organizationName: string;
}): Promise<boolean> {
  if (!resend) {
    console.warn(
      "RESEND_API_KEY is not configured; cannot send a notification email confirmation link.",
    );
    return false;
  }

  const confirmUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/notification-email/confirm?token=${encodeURIComponent(params.token)}`;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

  try {
    const { error } = await resend.emails.send({
      from: `Velemenytap <${fromAddress}>`,
      to: [params.email],
      subject: "Erősítsd meg az értesítési e-mail címet",
      html: `
        <p><strong>${escapeHtml(params.organizationName)}</strong> ezt az e-mail címet szeretné beállítani a negatív vélemény-értesítések fogadására.</p>
        <p>Ha ezt te kérted, erősítsd meg az alábbi linkre kattintva:</p>
        <p><a href="${confirmUrl}">E-mail cím megerősítése</a></p>
        <p>A link 24 órán belül lejár. Ha nem te kérted ezt, nyugodtan hagyd figyelmen kívül ezt az üzenetet.</p>
      `,
    });
    if (error) {
      console.error("Failed to send notification email confirmation:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Failed to send notification email confirmation:", error);
    return false;
  }
}
