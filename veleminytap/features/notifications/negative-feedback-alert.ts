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
  nfcCardId: number;
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

  const admin = createAdminClient();
  // Set once a claim succeeds; used in the `finally` block below to report
  // this attempt's real outcome (round-3 R3-06) regardless of which return
  // or throw path this function takes after that point -- a reservation
  // that's claimed must always be finalized as either delivered or failed,
  // never left silently unresolved by an early return (no recipients) or
  // an unexpected exception.
  let logId: number | null = null;
  let delivered = false;

  try {
    // Atomic claim: caps this at one alert per card per 5-minute cooldown
    // (finding #2, round 1) AND one alert per organization per hour
    // regardless of how many different cards it comes from (round-2
    // finding R2-08 -- the per-card cooldown alone doesn't bound total
    // email volume across an org's cards), serialized across concurrent
    // claims for different cards in the same org (round-3 finding R3-02).
    // last_negative_alert_at is genuinely server-owned: a trigger rejects
    // any direct UPDATE to it from any caller, including this admin
    // client -- the only way to change it is through this function, which
    // is EXECUTE-restricted to service_role. See its migration for the
    // full reasoning, including why a round-1 version of this same
    // cooldown (a raw UPDATE from here) was not actually a sufficient fix
    // on its own: an authenticated tenant's own session could reset it via
    // a direct UPDATE, since RLS is row-level, not column-level.
    //
    // Returns the new log row's id (a *reservation*, not a record of
    // delivery -- round-3 finding R3-06) or null if nothing was claimed.
    const { data: claimedLogId, error: claimError } = await admin.rpc("claim_negative_alert_send", {
      p_nfc_card_id: params.nfcCardId,
    });

    if (claimError) {
      console.error("Failed to claim negative feedback alert cooldown:", claimError);
      return;
    }
    if (claimedLogId === null) {
      return;
    }
    logId = claimedLogId;

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

      if (members) {
        for (const member of members) {
          const { data } = await admin.auth.admin.getUserById(member.user_id);
          if (data.user?.email) recipients.push(data.user.email);
        }
      }
    }
    if (recipients.length === 0) {
      // A reservation was claimed but there's no one to send to -- this
      // is a failed attempt, not a silent success (R3-06); the `finally`
      // block below finalizes it as such.
      console.warn("Claimed a negative feedback alert slot but found no recipients to notify.");
      return;
    }

    const dashboardUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/feedback`;
    const stars = "★".repeat(params.rating) + "☆".repeat(5 - params.rating);
    const fromAddress = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

    const { error: sendError } = await resend.emails.send({
      from: `Velemenytap <${fromAddress}>`,
      to: recipients,
      subject: `${stars} Új vélemény itt: ${params.locationName}`,
      html: `
        <p>${escapeHtml(params.organizationName)} most kapott egy ${params.rating} csillagos véleményt itt: <strong>${escapeHtml(params.locationName)}</strong>${params.cardName ? ` (${escapeHtml(params.cardName)})` : ""}.</p>
        ${
          params.feedbackText
            ? `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ddd;color:#333;">${escapeHtml(params.feedbackText)}</blockquote>`
            : "<p>Nem érkezett írásos vélemény.</p>"
        }
        <p><a href="${dashboardUrl}">Megtekintés a vélemény-postaládában</a></p>
      `,
    });

    // The SDK returns { data, error } instead of throwing on API failures
    // (only a network/parsing failure would land in the catch block below),
    // and its own console logging is dev-only, so this is the only place
    // a production send failure would ever be visible.
    if (sendError) {
      console.error("Failed to send negative feedback alert email:", sendError);
      return;
    }

    delivered = true;
  } catch (error) {
    console.error("Failed to send negative feedback alert email:", error);
  } finally {
    if (logId !== null) {
      const { error: finalizeError } = await admin.rpc("finalize_negative_alert_send", {
        p_log_id: logId,
        p_delivered: delivered,
      });
      if (finalizeError) {
        console.error("Failed to finalize negative feedback alert log:", finalizeError);
      }
    }
  }
}
