"use server";

import { after } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeGoogleReviewUrl } from "@/lib/google-review-url";
import { feedbackSchema } from "./schema";
import {
  isNegativeRating,
  sendNegativeFeedbackAlert,
} from "@/features/notifications/negative-feedback-alert";

/**
 * Why the error variant carries a `code`.
 *
 * The Google Review CTA used to exist only on the success screen, so EVERY
 * failed submission silently removed the customer's route to Google. Two of
 * those failures are not the customer doing anything wrong:
 *
 *   * `duplicate` -- they already submitted on this card within the last few
 *     minutes. Re-tapping the card is exactly what someone does when they lost
 *     the confirmation screen and wanted the Google button, and it was the one
 *     path that refused to give it to them.
 *   * `rate_limited` -- the card is busy. Their feedback was not recorded, but
 *     nothing about that should stop them reviewing on Google.
 *
 * The other two deliberately do NOT offer it: `inactive` means the business
 * has turned this card off, and `failed` is an unknown error where retrying is
 * the right next action rather than being sent elsewhere.
 *
 * This is not a review-gating question -- the CTA was lost identically for 1
 * and 5 stars -- but it removed the product's whole purpose from the customers
 * most likely to act on it.
 */
export type FeedbackErrorCode = "duplicate" | "rate_limited" | "inactive" | "failed";

export type FeedbackActionState =
  | { status: "idle" }
  | { status: "error"; error: string; code: FeedbackErrorCode }
  | { status: "success"; organizationName: string; googleReviewUrl: string | null };

// Anti-spam posture for this endpoint (documented in SECURITY.md): the
// database-backed per-card rate limit inside submit_feedback_atomic (see
// its migration) handles a scripted flood -- it doesn't need in-process
// state, so it works correctly across Vercel's independent serverless
// instances, unlike an in-memory limiter would. Layered on top of that is
// the practical, near-zero-cost case that actually matters for casual NFC
// use: an accidental double-tap or a customer re-submitting the same card a
// few times in a row. A short-lived, HttpOnly, card-scoped cookie (no
// personal data, just an opaque marker) blocks that without touching
// legitimate customers on other cards or other visits.
const DUPLICATE_WINDOW_SECONDS = 5 * 60;

function duplicateCookieName(publicId: string): string {
  return `fb_sent_${publicId}`;
}

/**
 * The only write path into the feedback table (see the schema migration --
 * there is no INSERT policy for anon/authenticated on purpose). Delegates
 * to submit_feedback_atomic, which re-derives organization_id/location_id/
 * nfc_card_id from public_id and re-checks the card/location are active as
 * part of the same atomic operation as the insert -- not a separate lookup
 * that could go stale between the check and the write.
 */
export async function submitFeedbackAction(
  _prevState: FeedbackActionState,
  formData: FormData,
): Promise<FeedbackActionState> {
  const parsed = feedbackSchema.safeParse({
    public_id: formData.get("public_id"),
    rating: formData.get("rating"),
    feedback_text: formData.get("feedback_text") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "error",
      error: parsed.error.issues[0]?.message ?? "Hiba történt. Kérjük, próbáld újra.",
      code: "failed",
    };
  }

  const cookieStore = await cookies();
  const cookieName = duplicateCookieName(parsed.data.public_id);
  if (cookieStore.get(cookieName)) {
    return {
      status: "error",
      error: "Ehhez a látogatáshoz már küldtél véleményt. Köszönjük!",
      code: "duplicate",
    };
  }

  // submit_feedback_atomic does the active-status check and the insert as
  // one atomic database operation (locking the card row for the duration),
  // closing the race a separate lookup-then-insert had: the card/location
  // could be deactivated in between the two round trips, and the insert
  // would still go through. It also enforces a per-card rate limit (see the
  // migration) -- both are review findings #6 and #2 respectively.
  const admin = createAdminClient();
  const { data: result, error } = await admin
    .rpc("submit_feedback_atomic", {
      p_public_id: parsed.data.public_id,
      p_rating: parsed.data.rating,
      p_feedback_text: parsed.data.feedback_text,
    })
    .single();

  if (error) {
    if (error.code === "VT001" || error.code === "VT002") {
      return { status: "error", error: "Ez a link már nem aktív.", code: "inactive" };
    }
    if (error.code === "VT003") {
      return {
        status: "error",
        error: "Túl sok vélemény érkezett erről a kártyáról. Kérjük, próbáld újra pár perc múlva.",
        code: "rate_limited",
      };
    }
    return {
      status: "error",
      error: "Nem sikerült elküldeni a véleményedet. Kérjük, próbáld újra.",
      code: "failed",
    };
  }

  const card = {
    organizationId: result.organization_id,
    nfcCardId: result.nfc_card_id,
    organizationName: result.organization_name,
    locationName: result.location_name,
    cardName: result.card_name,
    googleReviewUrl: safeGoogleReviewUrl(result.google_review_url),
  };

  cookieStore.set(cookieName, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: DUPLICATE_WINDOW_SECONDS,
    path: `/r/${parsed.data.public_id}`,
  });

  // Negative-feedback alerts are a side effect of a successful submission,
  // never a condition of one: this must never affect the customer-facing
  // response (success/failure, timing, or the Google Review CTA below),
  // which is exactly why it's deferred to after() -- it runs once the
  // response has already been sent, so email latency or a Resend outage
  // can't slow down or break the submission.
  if (isNegativeRating(parsed.data.rating)) {
    after(() =>
      sendNegativeFeedbackAlert({
        organizationId: card.organizationId,
        nfcCardId: card.nfcCardId,
        organizationName: card.organizationName,
        locationName: card.locationName,
        cardName: card.cardName,
        rating: parsed.data.rating,
        feedbackText: parsed.data.feedback_text,
      }),
    );
  }

  return {
    status: "success",
    organizationName: card.organizationName,
    googleReviewUrl: card.googleReviewUrl,
  };
}
