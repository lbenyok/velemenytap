"use client";

import { useActionState, useState } from "react";
import { submitFeedbackAction, type FeedbackActionState } from "./actions";
import { StarPicker } from "./star-picker";

const REFLECTIONS: Record<number, string> = {
  1: "We're sorry it wasn't great.",
  2: "Thanks for letting us know.",
  3: "Good to know, thank you.",
  4: "Glad you enjoyed it!",
  5: "Wonderful — thank you!",
};

const initialState: FeedbackActionState = { status: "idle" };

export function FeedbackFlow({
  publicId,
  organizationName,
  locationName,
}: {
  publicId: string;
  organizationName: string;
  locationName: string;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [state, formAction, isPending] = useActionState(
    submitFeedbackAction,
    initialState,
  );

  if (state.status === "success") {
    return (
      <ConfirmationScreen
        organizationName={state.organizationName}
        googleReviewUrl={state.googleReviewUrl}
      />
    );
  }

  return (
    <div className="public-feedback flex min-h-svh flex-col items-center bg-[var(--pf-bg)] px-5 py-12 text-[var(--pf-ink)]">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <p className="text-sm text-[var(--pf-ink-muted)]">{organizationName}</p>
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            How was your visit to {locationName}?
          </h1>
        </div>

        <form action={formAction} className="space-y-6">
          <input type="hidden" name="public_id" value={publicId} />
          <input type="hidden" name="rating" value={rating ?? ""} />

          <StarPicker value={rating} onChange={setRating} />

          {rating ? (
            <div className="space-y-4">
              <p className="text-center text-sm font-medium">
                {REFLECTIONS[rating]}
              </p>
              <textarea
                name="feedback_text"
                placeholder="Anything you'd like to add? (optional)"
                rows={4}
                maxLength={1000}
                className="w-full resize-none rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] p-3 text-sm text-[var(--pf-ink)] outline-none placeholder:text-[var(--pf-ink-muted)] focus-visible:ring-2 focus-visible:ring-[var(--pf-wine)]"
              />
              {state.status === "error" ? (
                <p className="text-center text-sm text-red-700" role="alert">
                  {state.error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={isPending}
                className="w-full rounded-lg bg-[var(--pf-wine)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-wine-hover)] disabled:opacity-60"
              >
                {isPending ? "Sending…" : "Send feedback"}
              </button>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function ConfirmationScreen({
  organizationName,
  googleReviewUrl,
}: {
  organizationName: string;
  googleReviewUrl: string | null;
}) {
  return (
    <div className="public-feedback flex min-h-svh flex-col items-center justify-center gap-8 bg-[var(--pf-bg)] px-5 py-12 text-center text-[var(--pf-ink)]">
      <div className="space-y-2">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--pf-wine)] text-white">
          <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Thank you!</h1>
        <p className="text-sm text-[var(--pf-ink-muted)]">
          Your feedback for {organizationName} has been sent.
        </p>
      </div>
      {googleReviewUrl ? (
        <div className="w-full max-w-sm space-y-3">
          <p className="text-sm text-[var(--pf-ink-muted)]">
            Would you like to share it on Google too?
          </p>
          <a
            href={googleReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg bg-[var(--pf-wine)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-wine-hover)]"
          >
            Leave a Google review
          </a>
        </div>
      ) : null}
    </div>
  );
}
