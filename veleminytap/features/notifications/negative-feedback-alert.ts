import "server-only";

import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";

const NEGATIVE_RATING_THRESHOLD = 2; // ratings 1-2 are treated as negative
const ALERT_ROLES = ["owner", "admin", "manager"] as const;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isNegativeRating(rating: number): boolean {
  return rating <= NEGATIVE_RATING_THRESHOLD;
}

/**
 * Emails the organization's owner/admin/manager members about a single
 * qualifying (rating <= 2) feedback submission. Never awaited by the
 * caller's response path -- see the after() call at the submitFeedbackAction
 * call site. Never throws: a failed/unconfigured send must not affect the
 * customer-facing feedback submission it's reacting to.
 */
export async function sendNegativeFeedbackAlert(params: {
  organizationId: number;
  organizationName: string;
  locationName: string;
  cardName: string | null;
  rating: number;
  feedbackText: string | null;
}): Promise<void> {
  if (!resend) {
    console.warn(
      "RESEND_API_KEY is not configured; skipping negative feedback alert email.",
    );
    return;
  }

  try {
    const admin = createAdminClient();

    // A configured notification_email is an explicit override of the
    // default "email every owner/admin/manager" behavior -- it's how an
    // org routes alerts to a shared inbox instead of individual accounts.
    const { data: org } = await admin
      .from("organizations")
      .select("notification_email")
      .eq("id", params.organizationId)
      .single();

    let recipients: string[] = [];
    if (org?.notification_email) {
      recipients = [org.notification_email];
    } else {
      const { data: members } = await admin
        .from("organization_memberships")
        .select("user_id")
        .eq("organization_id", params.organizationId)
        .in("role", ALERT_ROLES);

      if (!members || members.length === 0) return;

      for (const member of members) {
        const { data } = await admin.auth.admin.getUserById(member.user_id);
        if (data.user?.email) recipients.push(data.user.email);
      }
    }
    if (recipients.length === 0) return;

    const dashboardUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/feedback`;
    const stars = "★".repeat(params.rating) + "☆".repeat(5 - params.rating);
    const fromAddress = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

    const { error: sendError } = await resend.emails.send({
      from: `Velemenytap <${fromAddress}>`,
      to: recipients,
      subject: `${stars} New feedback for ${params.locationName}`,
      html: `
        <p>${escapeHtml(params.organizationName)} just received ${params.rating}-star feedback at <strong>${escapeHtml(params.locationName)}</strong>${params.cardName ? ` (${escapeHtml(params.cardName)})` : ""}.</p>
        ${
          params.feedbackText
            ? `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ddd;color:#333;">${escapeHtml(params.feedbackText)}</blockquote>`
            : "<p>No written feedback was left.</p>"
        }
        <p><a href="${dashboardUrl}">View in your feedback inbox</a></p>
      `,
    });

    // The SDK returns { data, error } instead of throwing on API failures
    // (only a network/parsing failure would land in the catch block below),
    // and its own console logging is dev-only, so this is the only place
    // a production send failure would ever be visible.
    if (sendError) {
      console.error("Failed to send negative feedback alert email:", sendError);
    }
  } catch (error) {
    console.error("Failed to send negative feedback alert email:", error);
  }
}
