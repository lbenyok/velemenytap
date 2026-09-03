"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS: Record<number, string> = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Great",
  5: "Excellent",
};

export function StarPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (rating: number) => void;
}) {
  return (
    <div
      className="flex justify-center"
      role="radiogroup"
      aria-label="Rate your visit"
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n === 1 ? "" : "s"} — ${LABELS[n]}`}
            onClick={() => onChange(n)}
            className="flex size-14 shrink-0 items-center justify-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-[var(--pf-wine)]"
          >
            <Star
              className={cn(
                "size-9 transition-colors",
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
  );
}
