"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS: Record<number, string> = {
  1: "Gyenge",
  2: "Elfogadható",
  3: "Jó",
  4: "Nagyszerű",
  5: "Kiváló",
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
      aria-label="Értékeld a látogatást"
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} csillag — ${LABELS[n]}`}
            onClick={() => onChange(n)}
            className="flex size-14 shrink-0 items-center justify-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
          >
            <Star
              className={cn(
                "size-9 transition-colors",
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
  );
}
