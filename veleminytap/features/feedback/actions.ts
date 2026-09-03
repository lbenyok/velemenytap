"use server";

import { after } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupPublicCard } from "./card-lookup";
import {
  isNegativeRating,
  sendNegativeFeedbackAlert,
} from "@/features/notifications/negative-feedback-alert";

export type FeedbackActionState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "success"; organizationName: string; googleReviewUrl: string | null };

const feedbackSchema = z.object({
  public_id: z.string().uuid(),
  rating: z.coerce.number().int().min(1).max(5),
  feedback_text: z
    .string()
    .trim()
    .max(1000, "Please keep feedback under 1000 characters.")
    .transform((v) => (v === "" ? null : v)),
});

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
      error: parsed.error.issues[0]?.message ?? "Something went wrong. Please try again.",
    };
  }

  const card = await lookupPublicCard(parsed.data.public_id);
  if (!card || !card.isActive) {
    return { status: "error", error: "This feedback link is no longer active." };
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
      error: "Could not send your feedback. Please try again.",
    };
  }

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
