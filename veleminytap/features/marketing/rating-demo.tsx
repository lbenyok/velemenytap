"use client";

import { useState } from "react";
import { Star, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS: Record<number, string> = {
  1: "Gyenge",
  2: "Elfogadható",
  3: "Jó",
  4: "Nagyszerű",
  5: "Kiváló",
};

const REFLECTIONS: Record<number, string> = {
  1: "Sajnáljuk, hogy nem voltál elégedett.",
  2: "Köszönjük, hogy jelezted.",
  3: "Jó tudni, köszönjük.",
  4: "Örülünk, hogy élvezted!",
  5: "Csodálatos — köszönjük!",
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
    <div className="public-feedback w-full max-w-sm rounded-2xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6 shadow-[0_1px_2px_rgba(19,23,34,0.06),0_16px_40px_-16px_rgba(33,84,235,0.35)] sm:p-7">
      <p className="text-center text-xs tracking-wide text-[var(--pf-ink-muted)]">
        Próbáld ki — koppints egy értékelésre
      </p>

      <div
        className="mt-4 flex justify-center"
        role="radiogroup"
        aria-label="Demó: értékeld a látogatást"
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = rating !== null && n <= rating;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} csillag — ${LABELS[n]}`}
              onClick={() => setRating(n)}
              className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] sm:size-12"
            >
              <Star
                className={cn(
                  "size-7 transition-colors sm:size-8",
                  filled
                    ? "fill-[var(--pf-accent-2)] text-[var(--pf-accent-2)]"
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
            Válassz egy értékelést, ahogy a vásárlód is tenné.
          </p>
        ) : (
          <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 space-y-3 motion-safe:duration-300">
            <p className="text-center text-sm font-medium text-[var(--pf-ink)]">
              {REFLECTIONS[rating]}
            </p>
            <div className="flex items-center justify-center gap-2 rounded-lg bg-[var(--pf-accent)] px-4 py-2.5 text-center text-sm font-medium text-white">
              <Check className="size-4 shrink-0" strokeWidth={2.5} />
              Ugyanaz a &bdquo;Google-értékelés írása&rdquo; link, mint
              bármelyik másik értékelésnél
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
