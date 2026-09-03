"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupPublicCard } from "./card-lookup";

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

  return {
    status: "success",
    organizationName: card.organizationName,
    googleReviewUrl: card.googleReviewUrl,
  };
}
