"use client";

import { useState } from "react";
import { Star, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS: Record<number, string> = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Great",
  5: "Excellent",
};

const REFLECTIONS: Record<number, string> = {
  1: "We're sorry it wasn't great.",
  2: "Thanks for letting us know.",
  3: "Good to know, thank you.",
  4: "Glad you enjoyed it!",
  5: "Wonderful — thank you!",
};

/**
 * A live, clickable replica of the real /r/[publicId] rating flow --
 * same components, same colors, same copy. Not a screenshot: the point is
 * that a visitor can tap any star, including 1, and watch the exact same
 * "leave a review" step appear every time. Proof, not a claim.
 */
export function RatingDemo() {
  const [rating, setRating] = useState<number | null>(null);

  return (
    <div className="public-feedback w-full max-w-sm rounded-2xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6 shadow-[0_1px_2px_rgba(36,27,22,0.06),0_16px_40px_-16px_rgba(91,35,56,0.35)] sm:p-7">
      <p className="text-center text-xs tracking-wide text-[var(--pf-ink-muted)]">
        Try it — tap any rating
      </p>

      <div
        className="mt-4 flex justify-center"
        role="radiogroup"
        aria-label="Demo: rate your visit"
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = rating !== null && n <= rating;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"} — ${LABELS[n]}`}
              onClick={() => setRating(n)}
              className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-[var(--pf-wine)] sm:size-12"
            >
              <Star
                className={cn(
                  "size-7 transition-colors sm:size-8",
                  filled
                    ? "fill-[var(--pf-gold)] text-[var(--pf-gold)]"
                    : "fill-none text-[var(--pf-line)]",
                )}
                strokeWidth={1.5}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-5 min-h-[76px]">
        {rating === null ? (
          <p className="text-center text-sm text-[var(--pf-ink-muted)]">
            Pick a rating, same as your customer would.
          </p>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-1 space-y-3 duration-300">
            <p className="text-center text-sm font-medium text-[var(--pf-ink)]">
              {REFLECTIONS[rating]}
            </p>
            <div className="flex items-center justify-center gap-2 rounded-lg bg-[var(--pf-wine)] px-4 py-2.5 text-sm font-medium text-white">
              <Check className="size-4" strokeWidth={2.5} />
              Same &ldquo;Leave a Google review&rdquo; link as any other rating
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
