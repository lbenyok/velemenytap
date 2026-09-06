"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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

export function TourDialog({
  phase,
  stepIndex,
  onOpenChange,
}: {
  phase: "closed" | "welcome" | "step";
  stepIndex: number;
  onOpenChange: (open: boolean) => void;
}) {
  const { next, back, beginSteps, skip, complete } = useTour();
  const router = useRouter();
  const highlightedRef = useRef<HTMLElement | null>(null);
  const step = phase === "step" ? TOUR_STEPS[stepIndex] : null;

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
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={skip}>
                Kihagyom
              </Button>
              <Button type="button" onClick={beginSteps}>
                Kezdjük
              </Button>
            </DialogFooter>
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
            {step.action ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    complete();
                    router.push(step.action!.href);
                  }}
                >
                  {step.action.label}
                </Button>
              </div>
            ) : null}
            <DialogFooter className="sm:justify-between">
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={back} disabled={stepIndex === 0}>
                  Vissza
                </Button>
                <Button type="button" variant="ghost" onClick={skip}>
                  Kihagyom
                </Button>
              </div>
              {isLastStep ? (
                <Button type="button" onClick={complete}>
                  Bezárás
                </Button>
              ) : (
                <Button type="button" onClick={next}>
                  Következő
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
