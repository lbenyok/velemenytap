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
  const submissionStarted = useRef(false)
  const safeReviewUrl = safeGoogleReviewUrl(googleReviewUrl)
  const [state, formAction, isPending] = useActionState(
    async (
      previousState: FeedbackActionState,
      formData: FormData
    ): Promise<FeedbackActionState> => {
      try {
        return await submitFeedbackAction(previousState, formData)
      } catch {
        return {
          status: "error",
          code: "failed",
          error: "Nem sikerült elküldeni a véleményedet. Kérjük, próbáld újra.",
        }
      } finally {
        submissionStarted.current = false
      }
    },
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
              {rating < 4 ? (
                <>
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
                </>
              ) : null}
              {state.status === "error" ? (
                <div className="space-y-4">
                  <p className="text-center text-sm text-red-700" role="alert">
                    {state.error}
                  </p>
                  {ERROR_CODES_KEEPING_THE_CTA.has(state.code) && rating < 4 ? (
                    <GoogleReviewCta googleReviewUrl={googleReviewUrl} />
                  ) : null}
                </div>
              ) : null}
              {retryIsPointless || (rating >= 4 && safeReviewUrl) ? null : (
                <button
                  type="submit"
                  disabled={isPending}
                  className="w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)] disabled:opacity-60"
                >
                  {isPending ? "Küldés…" : "Vélemény küldése"}
                </button>
              )}
              {rating >= 4 && !(state.status === "error" && state.code === "inactive") ? (
                safeReviewUrl ? (
                  <>
                    <p className="text-center text-sm text-[var(--pf-ink-muted)]">
                      Elküldjük a visszajelzésedet, és új lapon megnyitjuk a
                      Google értékelési oldalát.
                    </p>
                    <a
                      href={safeReviewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-disabled={isPending}
                      onClick={(event) => {
                        if (isPending || submissionStarted.current) {
                          event.preventDefault()
                          return
                        }
                        // Keep this page alive for the save while Google opens immediately.
                        if (!retryIsPointless && formRef.current) {
                          submissionStarted.current = true
                          formRef.current.requestSubmit()
                        }
                      }}
                      className="block w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                      Vélemény küldése
                    </a>
                  </>
                ) : (
                  <p
                    role="alert"
                    className="text-center text-sm text-[var(--pf-ink-muted)]"
                  >
                    A Google értékelési link jelenleg nem érhető el.
                  </p>
                )
              ) : null}
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
  // Internal submissions keep a Google link on the confirmation screen.
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
      <GoogleReviewLink googleReviewUrl={safeReviewUrl} />
    </div>
  )
}

function GoogleReviewLink({
  googleReviewUrl,
}: {
  googleReviewUrl: string | null
}) {
  const safeReviewUrl = safeGoogleReviewUrl(googleReviewUrl)
  if (!safeReviewUrl) return null
  return (
    <div className="flex justify-center">
      <a
        href={safeReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Google-értékelés írása"
        title="Google-értékelés írása"
        className="inline-flex size-12 items-center justify-center rounded-full border border-[var(--pf-line)] bg-white shadow-sm transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <svg
          viewBox="0 0 48 48"
          className="size-6"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="#4285F4"
            d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.42h11a9.4 9.4 0 0 1-4.08 6.17v5.13h6.61c3.87-3.57 6.08-8.83 6.08-14.8Z"
          />
          <path
            fill="#34A853"
            d="M24 44c5.51 0 10.13-1.83 13.51-4.94l-6.61-5.13c-1.83 1.23-4.17 1.98-6.9 1.98-5.31 0-9.82-3.59-11.43-8.43H5.75v5.29A20 20 0 0 0 24 44Z"
          />
          <path
            fill="#FBBC05"
            d="M12.57 27.48a12 12 0 0 1 0-6.96v-5.29H5.75a20 20 0 0 0 0 17.54l6.82-5.29Z"
          />
          <path
            fill="#EA4335"
            d="M24 12.09c3 0 5.67 1.03 7.8 3.05l5.85-5.85A19.56 19.56 0 0 0 24 4 20 20 0 0 0 5.75 15.23l6.82 5.29C14.18 15.68 18.69 12.09 24 12.09Z"
          />
        </svg>
      </a>
    </div>
  )
}
