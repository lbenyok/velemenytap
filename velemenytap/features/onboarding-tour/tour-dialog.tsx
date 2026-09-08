"use client";

import { useEffect, useRef, useState } from "react";
import { useTour } from "./tour-provider";
import { TOUR_STEPS, TOUR_WELCOME } from "./tour-steps";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const HIGHLIGHT_CLASS = "tour-highlight";

/**
 * Finds a step's target by its data-tour attribute -- never by matching
 * visible text, which is Hungarian copy that can change independently of
 * this lookup -- and only if it's genuinely rendered right now.
 * `offsetParent` is null for anything under `display: none` (exactly what
 * `hidden xl:flex` applies to the desktop nav below that breakpoint), so
 * this is what actually distinguishes "visible on this viewport" from
 * "present in the DOM but hidden," which plain element existence can't.
 */
function findVisibleTarget(navTarget: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${navTarget}"]`);
  if (!el || el.offsetParent === null) return null;
  return el;
}

/**
 * Shown instead of the normal footer controls whenever a close attempt is
 * in flight or has failed -- found during an independent review: the
 * previous version fired the persistence call without awaiting it and
 * closed the dialog immediately regardless of outcome, so a failed save
 * looked identical to a successful one from the user's point of view. This
 * makes the actual state honest: saving shows progress, a failure offers a
 * real retry or an explicit, informed "close anyway" that does not pretend
 * the write succeeded.
 */
function PendingCloseBanner({
  saving,
  error,
  onRetry,
  onCloseAnyway,
}: {
  saving: boolean;
  error: string | null;
  onRetry: () => void;
  onCloseAnyway: () => void;
}) {
  if (saving) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Mentés folyamatban…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onRetry}>
          Próbáld újra
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCloseAnyway}>
          Bezárás mentés nélkül
        </Button>
      </div>
    </div>
  );
}

export function TourDialog({
  phase,
  stepIndex,
  onOpenChange,
}: {
  phase: "closed" | "welcome" | "step";
  stepIndex: number;
  onOpenChange: (open: boolean) => void;
}) {
  const { pending, next, back, beginSteps, skip, complete, retry, closeAnyway } = useTour();
  const highlightedRef = useRef<HTMLElement | null>(null);
  const step = phase === "step" ? TOUR_STEPS[stepIndex] : null;
  // Local only -- the final step's own action button needs to know it
  // triggered the current save attempt specifically, so it (and not the
  // generic pending banner) is what disables itself while waiting, and so
  // navigation only ever happens after complete() has actually resolved
  // true, never racing ahead of a still-in-flight or failed write.
  const [actionPending, setActionPending] = useState(false);

  // Highlights the current step's real, visible nav target (if any) and
  // always cleans up the PREVIOUS step's highlight -- including on
  // unmount, so closing the tour mid-step never leaves a stray ring on
  // the nav. Re-runs on resize too: a step whose target was hidden below
  // `xl` when it first rendered must pick up a highlight if the viewport
  // grows past that breakpoint mid-tour, and vice versa.
  useEffect(() => {
    function applyHighlight() {
      if (highlightedRef.current) {
        highlightedRef.current.classList.remove(HIGHLIGHT_CLASS);
        highlightedRef.current = null;
      }
      if (!step?.navTarget) return;
      const target = findVisibleTarget(step.navTarget);
      if (!target) return;
      target.classList.add(HIGHLIGHT_CLASS);
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      highlightedRef.current = target;
    }

    applyHighlight();
    window.addEventListener("resize", applyHighlight);
    return () => {
      window.removeEventListener("resize", applyHighlight);
      if (highlightedRef.current) {
        highlightedRef.current.classList.remove(HIGHLIGHT_CLASS);
        highlightedRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run exactly on step change, not on every render
  }, [phase, stepIndex]);

  const isLastStep = stepIndex === TOUR_STEPS.length - 1;
  const controlsDisabled = pending !== null;

  async function handleActionClick(href: string) {
    setActionPending(true);
    // Navigation itself happens inside the provider's attemptClose, not
    // here -- passing `href` through means it still fires after a later
    // successful retry too, not just when this specific call succeeds.
    // `pending.saving` (not this local flag) drives the UI once a retry is
    // in play; this flag only covers the window before the first attempt
    // either resolves or hands off to the shared pending/retry banner.
    await complete(href);
    setActionPending(false);
  }

  return (
    <Dialog open={phase !== "closed"} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {phase === "welcome" ? (
          <>
            <DialogHeader>
              <DialogTitle>{TOUR_WELCOME.title}</DialogTitle>
              <DialogDescription render={<div />}>
                {TOUR_WELCOME.body.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </DialogDescription>
            </DialogHeader>
            {pending ? (
              <PendingCloseBanner
                saving={pending.saving}
                error={pending.error}
                onRetry={retry}
                onCloseAnyway={closeAnyway}
              />
            ) : (
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={skip}>
                  Kihagyom
                </Button>
                <Button type="button" onClick={beginSteps}>
                  Kezdjük
                </Button>
              </DialogFooter>
            )}
          </>
        ) : step ? (
          <>
            <DialogHeader>
              <p className="text-xs font-medium text-muted-foreground">
                {stepIndex + 1}. lépés / {TOUR_STEPS.length}
              </p>
              <DialogTitle>{step.title}</DialogTitle>
              <DialogDescription render={<div />}>
                {step.body.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </DialogDescription>
            </DialogHeader>
            {step.action && !pending ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={actionPending}
                  onClick={() => void handleActionClick(step.action!.href)}
                >
                  {actionPending ? "Mentés…" : step.action.label}
                </Button>
              </div>
            ) : null}
            {pending ? (
              <PendingCloseBanner
                saving={pending.saving}
                error={pending.error}
                onRetry={retry}
                onCloseAnyway={closeAnyway}
              />
            ) : (
              <DialogFooter className="sm:justify-between">
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={back} disabled={stepIndex === 0 || controlsDisabled}>
                    Vissza
                  </Button>
                  <Button type="button" variant="ghost" onClick={skip} disabled={controlsDisabled}>
                    Kihagyom
                  </Button>
                </div>
                {isLastStep ? (
                  <Button type="button" onClick={() => void complete()} disabled={controlsDisabled}>
                    Bezárás
                  </Button>
                ) : (
                  <Button type="button" onClick={next} disabled={controlsDisabled}>
                    Következő
                  </Button>
                )}
              </DialogFooter>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
