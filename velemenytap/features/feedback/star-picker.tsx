"use client"

import { Star } from "lucide-react"
import { cn } from "@/lib/utils"

const LABELS: Record<number, string> = {
  1: "Gyenge",
  2: "Elfogadható",
  3: "Jó",
  4: "Nagyszerű",
  5: "Kiváló",
}

/**
 * A star tap is a submission, so only a deliberate activation may select.
 *
 * `onSelect` fires from `onClick` alone: a mouse click, a tap, or Enter/Space
 * on a focused star (which the browser delivers as a click). Hover and focus
 * never select -- there is deliberately no roving arrow-key selection either,
 * because moving focus through a radiogroup with the arrow keys would, under
 * the usual pattern, check each star it passes and so submit the first one.
 *
 * `disabled` uses aria-disabled rather than the disabled attribute, so focus
 * stays where the customer left it while a save is in flight.
 */
export function StarPicker({
  value,
  onSelect,
  disabled = false,
}: {
  value: number | null
  onSelect: (rating: number) => void
  disabled?: boolean
}) {
  return (
    <div
      className="flex justify-center"
      role="radiogroup"
      aria-label="Értékeld a látogatást"
      aria-disabled={disabled || undefined}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-disabled={disabled || undefined}
            aria-label={`${n} csillag — ${LABELS[n]}`}
            onClick={() => {
              if (!disabled) onSelect(n)
            }}
            className={cn(
              "flex size-14 shrink-0 items-center justify-center rounded-full transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]",
              disabled ? "cursor-default" : "active:scale-90"
            )}
          >
            <Star
              className={cn(
                "size-9 transition-colors",
                filled
                  ? "fill-[var(--pf-star)] text-[var(--pf-star-edge)]"
                  : "fill-none text-[var(--pf-line)]"
              )}
              strokeWidth={1.5}
            />
          </button>
        )
      })}
    </div>
  )
}
