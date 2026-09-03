"use server";

import { after } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupPublicCard } from "./card-lookup";
import { feedbackSchema } from "./schema";
import {
  isNegativeRating,
  sendNegativeFeedbackAlert,
} from "@/features/notifications/negative-feedback-alert";

export type FeedbackActionState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "success"; organizationName: string; googleReviewUrl: string | null };

// Anti-spam posture for this endpoint (documented in SECURITY.md): no IP-
// based or Redis-backed rate limiting, deliberately. Vercel's serverless
// functions don't share memory across instances, so an in-process limiter
// would be unreliable without adding real infrastructure -- not justified
// for MVP per "avoid unnecessary infrastructure." What's implemented
// instead is the practical, no-infra case that actually matters for NFC
// use: an accidental double-tap or a customer re-submitting the same card
// a few times in a row. A short-lived, HttpOnly, card-scoped cookie (no
// personal data, just an opaque marker) blocks that without touching
// legitimate customers on other cards or other visits.
const DUPLICATE_WINDOW_SECONDS = 5 * 60;

function duplicateCookieName(publicId: string): string {
  return `fb_sent_${publicId}`;
}

/**
 * The only write path into the feedback table (see the schema migration --
 * there is no INSERT policy for anon/authenticated on purpose). Re-derives
 * organization_id/location_id/nfc_card_id from a fresh server-side lookup
 * of public_id rather than trusting anything else the client might send,
 * and re-checks the card/location are still active at submission time
 * (they were valid when the page loaded, but could have been deactivated
 * in between).
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
    };
  }

  const cookieStore = await cookies();
  const cookieName = duplicateCookieName(parsed.data.public_id);
  if (cookieStore.get(cookieName)) {
    return {
      status: "error",
      error: "Ehhez a látogatáshoz már küldtél véleményt. Köszönjük!",
    };
  }

  const card = await lookupPublicCard(parsed.data.public_id);
  if (!card || !card.isActive) {
    return { status: "error", error: "Ez a link már nem aktív." };
  }

  const admin = createAdminClient();
  const { error } = await admin.from("feedback").insert({
    organization_id: card.organizationId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: parsed.data.rating,
    feedback_text: parsed.data.feedback_text,
  });

  if (error) {
    return {
      status: "error",
      error: "Nem sikerült elküldeni a véleményedet. Kérjük, próbáld újra.",
    };
  }

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
