"use client";

import { useState } from "react";
import { Star } from "lucide-react";
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
  3: "Jó hallani, köszönjük.",
  4: "Örülünk, hogy élvezted!",
  5: "Csodálatos, köszönjük!",
};

/** Interactive star-picker sample only; it never submits or opens Google. */
export function RatingDemo() {
  const [rating, setRating] = useState<number | null>(null);

  return (
    <div className="public-feedback w-full max-w-sm rounded-2xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6 shadow-[0_1px_2px_rgba(19,23,34,0.06),0_16px_40px_-16px_rgba(33,84,235,0.35)] sm:p-7">
      <p className="text-center text-xs tracking-wide text-[var(--pf-ink-muted)]">
        Próbáld ki a csillagválasztót
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
                    ? "fill-[var(--pf-star)] text-[var(--pf-star)]"
                    : "fill-[var(--pf-line)] text-[var(--pf-line)]",
                )}
                strokeWidth={0}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-5 min-h-[76px]">
        {rating === null ? (
          <p className="text-center text-sm text-[var(--pf-ink-muted)]">
            Válassz egy értékelést, és nézd meg, milyen egyszerű elindulni.
          </p>
        ) : (
          <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 space-y-3 motion-safe:duration-300">
            <p className="text-center text-sm font-medium text-[var(--pf-ink)]">
              {REFLECTIONS[rating]}
            </p>
            <div aria-live="polite" className="rounded-lg bg-[var(--pf-accent)]/10 px-4 py-2.5 text-center text-sm font-medium text-[var(--pf-accent)]">
              Kiválasztott értékelés: {rating}/5
            </div>
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-xs text-[var(--pf-ink-muted)]">
        Bemutató: nem küld értékelést, és nem nyitja meg a Google-t.
      </p>
    </div>
  );
}
