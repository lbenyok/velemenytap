"use client"

import { useActionState, useRef, useState } from "react"
import { submitFeedbackAction, type FeedbackActionState } from "./actions"
import { StarPicker } from "./star-picker"
import { safeGoogleReviewUrl } from "@/lib/google-review-url"

const REFLECTIONS: Record<number, string> = {
  1: "Sajnáljuk, hogy nem voltál elégedett.",
  2: "Köszönjük, hogy jelezted.",
  3: "Jó tudni, köszönjük.",
  4: "Örülünk, hogy élvezted!",
  5: "Csodálatos — köszönjük!",
}

const initialState: FeedbackActionState = { status: "idle" }

/**
 * The error codes on which a customer still gets their route to Google.
 *
 * `duplicate` and `rate_limited` are both "nothing you did was wrong": the
 * first is someone re-tapping a card they already reviewed -- which is exactly
 * what you do when you lost the confirmation screen and wanted the Google
 * button -- and the second is a busy card. Withholding the CTA there removed
 * the product's whole purpose from the customers most likely to act on it.
 *
 * `inactive` and `failed` deliberately do not: the business has switched that
 * card off, or something went wrong and retrying is the right next step.
 */
const ERROR_CODES_KEEPING_THE_CTA = new Set(["duplicate", "rate_limited"])

/**
 * Errors where pressing send again cannot possibly work: this visit is already
 * recorded, the card is busy, or the business switched it off. Offering the
 * submit actions there invites the customer to tap a thing that will fail the
 * same way -- and, since the primary action now carries the Google link too, it
 * would put a SECOND Google button on screen beside the one the error block
 * already shows. `failed` is deliberately absent: an unknown error is exactly
 * the case where retrying is the right next move.
 */
const ERROR_CODES_WHERE_RETRY_IS_POINTLESS = new Set([
  "duplicate",
  "rate_limited",
  "inactive",
])

export function FeedbackFlow({
  publicId,
  organizationName,
  locationName,
  googleReviewUrl,
}: {
  publicId: string
  organizationName: string
  locationName: string
  googleReviewUrl: string | null
}) {
  const [rating, setRating] = useState<number | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction, isPending] = useActionState(
    submitFeedbackAction,
    initialState
  )

  const retryIsPointless =
    state.status === "error" &&
    ERROR_CODES_WHERE_RETRY_IS_POINTLESS.has(state.code)

  if (state.status === "success") {
    return (
      <ConfirmationScreen
        organizationName={state.organizationName}
        googleReviewUrl={state.googleReviewUrl}
      />
    )
  }

  return (
    <div className="public-feedback flex min-h-svh flex-col items-center bg-[var(--pf-bg)] px-5 py-12 text-[var(--pf-ink)]">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <p className="text-sm text-[var(--pf-ink-muted)]">
            {organizationName}
          </p>
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            Milyen volt a tapasztalatod?
          </h1>
          <p className="text-sm text-[var(--pf-ink-muted)]">{locationName}</p>
        </div>

        <form ref={formRef} action={formAction} className="space-y-6">
          <input type="hidden" name="public_id" value={publicId} />
          <input type="hidden" name="rating" value={rating ?? ""} />

          <StarPicker value={rating} onChange={setRating} />

          {rating ? (
            <div className="space-y-4">
              <p className="text-center text-sm font-medium">
                {REFLECTIONS[rating]}
              </p>
              <label
                htmlFor="feedback_text"
                className="block text-sm font-medium"
              >
                Megjegyzés (nem kötelező)
              </label>
              <textarea
                id="feedback_text"
                name="feedback_text"
                placeholder="Van még valami, amit hozzátennél? (nem kötelező)"
                rows={4}
                maxLength={1000}
                className="w-full resize-none rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] p-3 text-sm text-[var(--pf-ink)] outline-none placeholder:text-[var(--pf-ink-muted)] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
              />
              <p className="text-xs text-[var(--pf-ink-muted)]">
                Ezt a visszajelzést a vállalkozás kapja meg, nem kerül a
                Google-re. Kérjük, ne írj ide személyes vagy egészségügyi
                adatot.
              </p>
              {state.status === "error" ? (
                <div className="space-y-4">
                  <p className="text-center text-sm text-red-700" role="alert">
                    {state.error}
                  </p>
                  {ERROR_CODES_KEEPING_THE_CTA.has(state.code) ? (
                    <GoogleReviewCta googleReviewUrl={googleReviewUrl} />
                  ) : null}
                </div>
              ) : null}
              {/*
                Two taps to Google instead of three -- for EVERY rating.

                The Google link used to live only on the confirmation screen, so
                reaching it meant: pick a star, send, then tap Google. It is now
                the primary action on this screen, and tapping it does both jobs
                at once: the browser opens Google in a new tab (its own default
                behaviour, from a real user gesture, so no popup blocker sees a
                script-opened window) while requestSubmit() sends the feedback in
                the tab left behind.

                Deliberately NOT conditional on the rating. A flow that sends 4-5
                stars straight to Google while 1-3 stars has to work for it is
                review gating: it is what PRODUCT_SPEC.md's one non-negotiable
                rule forbids, and it is the pattern Google penalises profiles
                for. The friction is removed for everyone or not at all -- which
                is also why the secondary button below is always available, for
                the customer who wants the business to hear them and has no
                interest in Google.
              */}
              {retryIsPointless ? null : safeGoogleReviewUrl(
                  googleReviewUrl
                ) ? (
                <a
                  href={safeGoogleReviewUrl(googleReviewUrl) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    // Guarded on isPending: the link stays tappable so a second
                    // tap still reaches Google, but it must not queue a second
                    // submission behind the first. That one would come back
                    // "duplicate" and replace the customer's own successful
                    // send with an error telling them they already sent it.
                    if (!isPending) formRef.current?.requestSubmit()
                  }}
                  className="block w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]"
                >
                  Küldés és Google-értékelés írása
                </a>
              ) : null}
              {retryIsPointless ? null : (
                <button
                  type="submit"
                  disabled={isPending}
                  className={
                    safeGoogleReviewUrl(googleReviewUrl)
                      ? "w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] px-4 py-3 text-sm font-medium text-[var(--pf-ink)] transition-colors hover:bg-[var(--pf-bg)] disabled:opacity-60"
                      : "w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)] disabled:opacity-60"
                  }
                >
                  {isPending ? "Küldés…" : "Csak elküldöm"}
                </button>
              )}
            </div>
          ) : null}
        </form>
      </div>
    </div>
  )
}

function ConfirmationScreen({
  organizationName,
  googleReviewUrl,
}: {
  organizationName: string
  googleReviewUrl: string | null
}) {
  // Validity of the destination is the only gate here -- never the rating.
  // Every rating from 1 to 5 reaches this same branch with the same link.
  return (
    <div className="public-feedback flex min-h-svh flex-col items-center justify-center gap-8 bg-[var(--pf-bg)] px-5 py-12 text-center text-[var(--pf-ink)]">
      <div className="space-y-2">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--pf-accent)] text-white">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="size-6"
            aria-hidden="true"
          >
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Köszönjük!</h1>
        <p className="text-sm text-[var(--pf-ink-muted)]">
          A véleményedet elküldtük ide: {organizationName}.
        </p>
      </div>
      <GoogleReviewCta googleReviewUrl={googleReviewUrl} />
    </div>
  )
}

/**
 * The one place the Google Review CTA is rendered, so every screen that offers
 * it offers exactly the same thing -- same wording, same prominence, same
 * validity check. Its ONLY condition is that the destination is a real Google
 * review link; it never inspects the rating, and there is deliberately no
 * parameter through which it could.
 */
function GoogleReviewCta({
  googleReviewUrl,
}: {
  googleReviewUrl: string | null
}) {
  const safeReviewUrl = safeGoogleReviewUrl(googleReviewUrl)
  if (!safeReviewUrl) return null
  return (
    <div className="w-full max-w-sm space-y-3">
      <p className="text-center text-sm text-[var(--pf-ink-muted)]">
        Megosztanád a Google-ön is?
      </p>
      <a
        href={safeReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]"
      >
        Google-értékelés írása
      </a>
    </div>
  )
}
