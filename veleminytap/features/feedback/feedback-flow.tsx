"use client";

import { useActionState, useState } from "react";
import { submitFeedbackAction, type FeedbackActionState } from "./actions";
import { StarPicker } from "./star-picker";

const REFLECTIONS: Record<number, string> = {
  1: "Sajnáljuk, hogy nem voltál elégedett.",
  2: "Köszönjük, hogy jelezted.",
  3: "Jó tudni, köszönjük.",
  4: "Örülünk, hogy élvezted!",
  5: "Csodálatos — köszönjük!",
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
            Milyen volt a látogatásod itt: {locationName}?
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
                placeholder="Van még valami, amit hozzátennél? (nem kötelező)"
                rows={4}
                maxLength={1000}
                className="w-full resize-none rounded-lg border border-[var(--pf-line)] bg-[var(--pf-surface)] p-3 text-sm text-[var(--pf-ink)] outline-none placeholder:text-[var(--pf-ink-muted)] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
              />
              {state.status === "error" ? (
                <p className="text-center text-sm text-red-700" role="alert">
                  {state.error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={isPending}
                className="w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)] disabled:opacity-60"
              >
                {isPending ? "Küldés…" : "Vélemény küldése"}
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
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--pf-accent)] text-white">
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
        <h1 className="text-xl font-semibold tracking-tight">Köszönjük!</h1>
        <p className="text-sm text-[var(--pf-ink-muted)]">
          A véleményedet elküldtük ide: {organizationName}.
        </p>
      </div>
      {googleReviewUrl ? (
        <div className="w-full max-w-sm space-y-3">
          <p className="text-sm text-[var(--pf-ink-muted)]">
            Megosztanád a Google-ön is?
          </p>
          <a
            href={googleReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg bg-[var(--pf-accent)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]"
          >
            Google-értékelés írása
          </a>
        </div>
      ) : null}
    </div>
  );
}
