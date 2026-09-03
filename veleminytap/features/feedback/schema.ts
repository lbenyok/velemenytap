import { z } from "zod";

/**
 * Validates a public feedback submission. Deliberately has no server-only
 * imports (unlike actions.ts) so it can be unit tested directly -- it's the
 * one place the "rating must be 1-5" and "text length" invariants live.
 */
export const feedbackSchema = z.object({
  public_id: z.string().uuid(),
  rating: z.coerce.number().int().min(1).max(5),
  feedback_text: z
    .string()
    .trim()
    .max(1000, "Please keep feedback under 1000 characters.")
    .transform((v) => (v === "" ? null : v)),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;
