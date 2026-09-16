"use client"

import { useRef, useState, type FormEvent } from "react"
import {
  attachCommentAction,
  saveRatingAction,
  type RatingErrorCode,
  type SaveRatingResult,
} from "./actions"
import { StarPicker } from "./star-picker"
import { safeGoogleReviewUrl } from "@/lib/google-review-url"

/**
 * The public rating flow: one tap on a star saves the rating.
 *
 * What happens next is IDENTICAL for every rating from 1 to 5 -- the same
 * confirmation, the same Google button in the same place with the same label,
 * and the same optional comment box. Only the comment box's prompt is worded
 * for the rating. A version that sent 4-5 stars straight to Google and held
 * 1-3 stars on a complaint form was asked for and declined: it is review
 * gating, which PRODUCT_SPEC.md forbids outright and Google's review policy
 * prohibits ("selectively solicit positive reviews"). e2e/review-gating.spec.ts
 * compares the 1-star and 5-star screens directly so it cannot creep back in.
 */

// A save that has not answered by then is reported as unconfirmed, never as
// saved. Retrying is safe: if the first attempt did land, the retry is refused
// as a duplicate and says so.
const SAVE_TIMEOUT_MS = 15_000

const COMMENT_PROMPTS: Record<number, string> = {
  1: "Mondd el, min javíthatnánk!",
  2: "Mondd el, min javíthatnánk!",
  3: "Mondd el, min javíthatnánk!",
  4: "Mit szerettél a legjobban?",
  5: "Mit szerettél a legjobban?",
}

type SaveErrorCode = RatingErrorCode | "timeout"

type Phase =
  | { kind: "choosing" }
  | { kind: "saving"; rating: number }
  | {
      kind: "saved"
      rating: number
      googleReviewUrl: string | null
      commentEnabled: boolean
    }
  | { kind: "error"; rating: number; code: SaveErrorCode; message: string }

/** Errors after which choosing a star again is the right next step. */
function canRetry(code: SaveErrorCode): boolean {
  return code === "failed" || code === "timeout"
}

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
  const [phase, setPhase] = useState<Phase>({ kind: "choosing" })
  // A ref, not state: two taps inside one frame both see the same stale
  // `phase`, and only a synchronously-updated ref stops the second one.
  const inFlight = useRef(false)

  const starsLocked =
    phase.kind === "saving" ||
    phase.kind === "saved" ||
    (phase.kind === "error" && !canRetry(phase.code))

  async function save(rating: number) {
    if (inFlight.current || starsLocked) return
    inFlight.current = true
    setPhase({ kind: "saving", rating })

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result: SaveRatingResult | "timeout" = await Promise.race([
        saveRatingAction({ publicId, rating }),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), SAVE_TIMEOUT_MS)
        }),
      ])
      if (result === "timeout") {
        setPhase({
          kind: "error",
          rating,
          code: "timeout",
          message:
            "Nem tudtuk megerősíteni, hogy az értékelésed elmentődött. Kérjük, próbáld újra.",
        })
      } else if (result.status === "saved") {
        setPhase({
          kind: "saved",
          rating,
          googleReviewUrl: result.googleReviewUrl,
          commentEnabled: result.commentEnabled,
        })
      } else {
        setPhase({
          kind: "error",
          rating,
          code: result.code,
          message: result.error,
        })
      }
    } catch {
      // The request itself failed (offline, dropped connection, server error).
      setPhase({
        kind: "error",
        rating,
        code: "failed",
        message:
          "Nem sikerült elmenteni az értékelésedet. Ellenőrizd a kapcsolatot, és próbáld újra.",
      })
    } finally {
      clearTimeout(timer)
      inFlight.current = false
    }
  }

  const selected = phase.kind === "choosing" ? null : phase.rating

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

        <div className="space-y-3">
          <p className="text-center text-sm text-[var(--pf-ink-muted)]">
            Egy koppintás a csillagra el is küldi az értékelésedet.
          </p>
          <StarPicker value={selected} onSelect={save} disabled={starsLocked} />
          <p
            aria-live="polite"
            className="min-h-5 text-center text-sm text-[var(--pf-ink-muted)]"
          >
            {phase.kind === "saving" ? "Mentés…" : ""}
          </p>
        </div>

        {phase.kind === "saved" ? (
          <div className="space-y-8">
            <p role="status" className="text-center text-sm font-medium">
              Köszönjük, az értékelésedet elmentettük.
            </p>
            <GoogleReviewCta googleReviewUrl={phase.googleReviewUrl} />
            {phase.commentEnabled ? (
              <CommentForm
                publicId={publicId}
                prompt={COMMENT_PROMPTS[phase.rating]}
              />
            ) : null}
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="space-y-6">
            <p className="text-center text-sm text-red-700" role="alert">
              {phase.message}
            </p>
            {canRetry(phase.code) ? (
              <button
                type="button"
                onClick={() => save(phase.rating)}
                className="w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] px-4 py-3 text-sm font-medium text-[var(--pf-ink)] transition-colors hover:bg-[var(--pf-bg)]"
              >
                Újrapróbálom
              </button>
            ) : null}
            {/*
              A card the business switched off is the one failure that does not
              offer Google: the business has taken this card out of use. Every
              other failure still does, whatever the rating.
            */}
            {phase.code === "inactive" ? null : (
              <GoogleReviewCta googleReviewUrl={googleReviewUrl} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function CommentForm({
  publicId,
  prompt,
}: {
  publicId: string
  prompt: string
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent" }
    | { kind: "error"; message: string; retryable: boolean }
  >({ kind: "idle" })
  const sending = useRef(false)

  if (state.kind === "sent") {
    return (
      <p role="status" className="text-center text-sm font-medium">
        Köszönjük, a megjegyzésedet továbbítottuk.
      </p>
    )
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current) return
    if (state.kind === "error" && !state.retryable) return
    const text = String(
      new FormData(event.currentTarget).get("feedback_text") ?? ""
    )
    sending.current = true
    setState({ kind: "sending" })
    try {
      const result = await attachCommentAction({ publicId, feedbackText: text })
      setState(
        result.status === "attached"
          ? { kind: "sent" }
          : {
              kind: "error",
              message: result.error,
              retryable: result.retryable,
            }
      )
    } catch {
      setState({
        kind: "error",
        message: "Nem sikerült elküldeni a megjegyzést. Kérjük, próbáld újra.",
        retryable: true,
      })
    } finally {
      sending.current = false
    }
  }

  const closed = state.kind === "error" && !state.retryable

  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-base font-semibold">{prompt}</h2>
      <label htmlFor="feedback_text" className="block text-sm font-medium">
        Megjegyzés a vállalkozásnak (nem kötelező)
      </label>
      <textarea
        id="feedback_text"
        name="feedback_text"
        rows={4}
        maxLength={1000}
        disabled={closed}
        className="w-full resize-none rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] p-3 text-sm text-[var(--pf-ink)] outline-none placeholder:text-[var(--pf-ink-muted)] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] disabled:opacity-60"
      />
      <p className="text-xs text-[var(--pf-ink-muted)]">
        Ezt csak a vállalkozás látja, nem kerül a Google-re. Kérjük, ne írj ide
        személyes vagy egészségügyi adatot.
      </p>
      {state.kind === "error" ? (
        <p className="text-sm text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
      {closed ? null : (
        <button
          type="submit"
          disabled={state.kind === "sending"}
          className="w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] px-4 py-3 text-sm font-medium text-[var(--pf-ink)] transition-colors hover:bg-[var(--pf-bg)] disabled:opacity-60"
        >
          {state.kind === "sending" ? "Küldés…" : "Megjegyzés küldése"}
        </button>
      )}
    </form>
  )
}

/**
 * The one place the Google Review CTA is rendered, so every screen that offers
 * it offers exactly the same thing -- same wording, same prominence, same
 * validity check. Its ONLY condition is that the destination is a real Google
 * review link; it never inspects the rating, and there is deliberately no
 * parameter through which it could.
 *
 * Same tab, from a real tap: the rating is already saved by the time this is
 * on screen, so leaving the page loses nothing that was promised.
 */
function GoogleReviewCta({
  googleReviewUrl,
}: {
  googleReviewUrl: string | null
}) {
  const safeReviewUrl = safeGoogleReviewUrl(googleReviewUrl)
  if (!safeReviewUrl) return null
  return (
    <div className="space-y-2">
      <a
        href={safeReviewUrl}
        className="block w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]"
      >
        Értékelés a Google-on
      </a>
      <p className="text-center text-xs text-[var(--pf-ink-muted)]">
        A Google oldalán te írod meg és te teszed közzé az értékelést.
      </p>
    </div>
  )
}
