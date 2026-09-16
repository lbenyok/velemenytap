import { z } from "zod"

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
    .max(1000, "A vélemény legfeljebb 1000 karakter lehet.")
    .transform((v) => (v === "" ? null : v)),
})

export type FeedbackInput = z.infer<typeof feedbackSchema>

/**
 * The star tap. It carries no text at all: the rating is saved on its own, and
 * a comment, if the customer writes one, arrives afterwards through
 * `commentSchema`.
 */
export const ratingSchema = z.object({
  public_id: z.string().uuid(),
  rating: z.coerce.number().int().min(1).max(5),
})

/**
 * A comment on a rating already saved. Unlike `feedbackSchema`, empty is an
 * error here rather than "no comment": sending nothing is not a comment.
 */
export const commentSchema = z.object({
  public_id: z.string().uuid(),
  feedback_text: z
    .string()
    .trim()
    .min(1, "Írj egy rövid megjegyzést, vagy hagyd üresen a mezőt.")
    .max(1000, "A megjegyzés legfeljebb 1000 karakter lehet."),
})
