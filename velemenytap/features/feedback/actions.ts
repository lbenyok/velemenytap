"use server"

import { createHash, randomBytes } from "node:crypto"
import { after } from "next/server"
import { cookies } from "next/headers"
import { createAdminClient } from "@/lib/supabase/admin"
import { safeGoogleReviewUrl } from "@/lib/google-review-url"
import { commentSchema, ratingSchema } from "./schema"
import {
  isNegativeRating,
  sendNegativeFeedbackAlert,
} from "@/features/notifications/negative-feedback-alert"

/**
 * The public flow is two requests now, not one.
 *
 *   1. `saveRatingAction` -- the star tap. The rating is saved immediately,
 *      so a customer who taps a star and walks away still counts.
 *   2. `attachCommentAction` -- optional, afterwards. It adds text to the row
 *      step 1 created, once, through `attach_feedback_comment`.
 *
 * Neither step ever looks at the rating to decide what the customer is
 * offered. Both return the same shapes for 1 star and for 5.
 *
 * Why the error variant carries a `code`: two failures are not the customer
 * doing anything wrong -- `duplicate` (they already rated this card in the
 * last few minutes, typically by re-tapping it to get back to the Google
 * button) and `rate_limited` (the card is busy) -- and `failed` is an unknown
 * error where the customer should be able to retry. All three still offer
 * the Google link. `inactive` does not: the business has switched the card
 * off.
 */
export type RatingErrorCode =
  "duplicate" | "rate_limited" | "inactive" | "failed"

export type SaveRatingResult =
  | {
      status: "saved"
      /** Re-read from the location at save time and validated, never echoed from the client. */
      googleReviewUrl: string | null
      /** False when the comment grant could not be issued; the rating itself is saved either way. */
      commentEnabled: boolean
    }
  | { status: "error"; code: RatingErrorCode; error: string }

export type AttachCommentResult =
  | { status: "attached" }
  | { status: "error"; error: string; retryable: boolean }

// Anti-spam posture for this endpoint (documented in SECURITY.md): the
// database-backed per-card rate limit inside submit_feedback_atomic (see its
// migration) handles a scripted flood across Vercel's independent serverless
// instances. Layered on top is the near-zero-cost case that matters for
// casual NFC use: an accidental double-tap or a customer re-rating the same
// card a few times in a row. A short-lived, HttpOnly, card-scoped cookie
// blocks that without touching other customers, cards or visits.
const DUPLICATE_WINDOW_SECONDS = 5 * 60

// How long a customer has to write the optional comment after tapping a star.
// Judged by the database clock in attach_feedback_comment; the cookie's own
// maxAge is only the browser's housekeeping.
const COMMENT_WINDOW_SECONDS = 30 * 60

// Two cookies, because they answer two different questions on two different
// clocks: "did this browser just rate this card?" (5 minutes) and "which
// saved rating may this browser still comment on?" (30 minutes). One cookie
// doing both would stretch the duplicate block to 30 minutes.
function sentCookieName(publicId: string): string {
  return `fb_sent_${publicId}`
}

function commentCookieName(publicId: string): string {
  return `fb_note_${publicId}`
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * The only write path that creates feedback rows (see the schema migration --
 * there is no INSERT policy for anon/authenticated on purpose). Delegates to
 * submit_feedback_atomic, which re-derives organization_id/location_id/
 * nfc_card_id from public_id and re-checks the card/location are active in
 * the same atomic operation as the insert.
 */
export async function saveRatingAction(input: {
  publicId: string
  rating: number
}): Promise<SaveRatingResult> {
  const parsed = ratingSchema.safeParse({
    public_id: input?.publicId,
    rating: input?.rating,
  })
  if (!parsed.success) {
    return {
      status: "error",
      code: "failed",
      error: "Nem sikerült elmenteni az értékelésedet. Kérjük, próbáld újra.",
    }
  }
  const { public_id: publicId, rating } = parsed.data

  const cookieStore = await cookies()
  if (cookieStore.get(sentCookieName(publicId))) {
    return {
      status: "error",
      code: "duplicate",
      error: "Ehhez a látogatáshoz már küldtél értékelést. Köszönjük!",
    }
  }

  const admin = createAdminClient()
  const { data: result, error } = await admin
    .rpc("submit_feedback_atomic", {
      p_public_id: publicId,
      p_rating: rating,
      p_feedback_text: null,
    })
    .single()

  if (error) {
    if (error.code === "VT001" || error.code === "VT002") {
      return {
        status: "error",
        code: "inactive",
        error: "Ez a kártya már nem aktív.",
      }
    }
    if (error.code === "VT003") {
      return {
        status: "error",
        code: "rate_limited",
        error:
          "Túl sok értékelés érkezett erről a kártyáról. Kérjük, próbáld újra pár perc múlva.",
      }
    }
    return {
      status: "error",
      code: "failed",
      error: "Nem sikerült elmenteni az értékelésedet. Kérjük, próbáld újra.",
    }
  }

  // The rating is committed from here on. Nothing below may turn that into a
  // reported failure: a customer told "try again" would create a second row.
  const token = randomBytes(32).toString("base64url")
  const { error: grantError } = await admin.rpc(
    "issue_feedback_comment_grant",
    {
      p_feedback_id: result.feedback_id,
      p_token_hash: hashToken(token),
      p_ttl_seconds: COMMENT_WINDOW_SECONDS,
    }
  )
  if (grantError) {
    console.error("Failed to issue a feedback comment grant:", {
      code: grantError.code,
    })
  }

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: `/r/${publicId}`,
  }
  cookieStore.set(sentCookieName(publicId), "1", {
    ...cookieOptions,
    maxAge: DUPLICATE_WINDOW_SECONDS,
  })
  if (!grantError) {
    cookieStore.set(commentCookieName(publicId), token, {
      ...cookieOptions,
      maxAge: COMMENT_WINDOW_SECONDS,
    })
  }

  // Negative-feedback alerts are a side effect of a saved rating, never a
  // condition of one, and never awaited: after() runs once the response has
  // gone, so email latency or a Resend outage cannot slow down or break the
  // customer's interaction. The comment, if one follows, is visible in the
  // dashboard inbox the email links to.
  if (isNegativeRating(rating)) {
    after(() =>
      sendNegativeFeedbackAlert({
        organizationId: result.organization_id,
        nfcCardId: result.nfc_card_id,
        organizationName: result.organization_name,
        locationName: result.location_name,
        cardName: result.card_name,
        rating,
        feedbackText: null,
      })
    )
  }

  return {
    status: "saved",
    googleReviewUrl: safeGoogleReviewUrl(result.google_review_url),
    commentEnabled: !grantError,
  }
}

export async function attachCommentAction(input: {
  publicId: string
  feedbackText: string
}): Promise<AttachCommentResult> {
  const parsed = commentSchema.safeParse({
    public_id: input?.publicId,
    feedback_text: input?.feedbackText,
  })
  if (!parsed.success) {
    return {
      status: "error",
      error:
        parsed.error.issues[0]?.message ??
        "Nem sikerült elküldeni a megjegyzést.",
      retryable: true,
    }
  }

  const cookieStore = await cookies()
  const token = cookieStore.get(commentCookieName(parsed.data.public_id))?.value
  if (!token) {
    return {
      status: "error",
      error:
        "A megjegyzés ideje lejárt, ezért már nem tudjuk az értékelésedhez csatolni.",
      retryable: false,
    }
  }

  const admin = createAdminClient()
  const { data: outcome, error } = await admin.rpc("attach_feedback_comment", {
    p_token_hash: hashToken(token),
    p_feedback_text: parsed.data.feedback_text,
  })

  if (error) {
    return {
      status: "error",
      error: "Nem sikerült elküldeni a megjegyzést. Kérjük, próbáld újra.",
      retryable: true,
    }
  }

  switch (outcome) {
    case "attached":
      return { status: "attached" }
    case "used":
    case "has_text":
      return {
        status: "error",
        error: "Ehhez az értékeléshez már küldtél megjegyzést.",
        retryable: false,
      }
    default:
      return {
        status: "error",
        error:
          "A megjegyzés ideje lejárt, ezért már nem tudjuk az értékelésedhez csatolni.",
        retryable: false,
      }
  }
}
