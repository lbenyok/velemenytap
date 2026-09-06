"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { setOnboardingTourStatusAction } from "./actions";
import { TourDialog } from "./tour-dialog";
import type { OnboardingTourStatus } from "@/lib/supabase/database.types";

type TourPhase = "closed" | "welcome" | "step";

type TourContextValue = {
  phase: TourPhase;
  stepIndex: number;
  /** Opens from the welcome screen -- used both for the automatic
   * first-time show and for the manual "Útmutató megnyitása" reopen
   * button, which is exactly why reopening never touches the persisted
   * status (see actions.ts): it's the same entry point either way. */
  open: () => void;
  next: () => void;
  back: () => void;
  beginSteps: () => void;
  /** Records "skipped" and closes -- used by the Kihagyom button and by
   * any implicit dismissal (Escape, backdrop click). */
  skip: () => void;
  /** Records "completed" and closes -- used only by the final step's own
   * Bezárás button, i.e. someone who actually went through the tour. */
  complete: () => void;
};

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error("useTour must be used within a TourProvider");
  }
  return ctx;
}

export function TourProvider({
  initialStatus,
  children,
}: {
  initialStatus: OnboardingTourStatus;
  children: ReactNode;
}) {
  // "not_started" is the only status that auto-opens the tour -- everything
  // else (completed, skipped, and every existing organization backfilled
  // by the migration) renders the dashboard exactly as if this feature
  // didn't exist, until someone deliberately reopens it.
  const [phase, setPhase] = useState<TourPhase>(
    initialStatus === "not_started" ? "welcome" : "closed",
  );
  const [stepIndex, setStepIndex] = useState(0);
  // Set just before a deliberate close (skip or complete) so the single
  // persistence effect below knows which status to record, without
  // duplicating that server call across every button that can close the
  // dialog (buttons, Escape, backdrop click all funnel through setPhase).
  const pendingStatusRef = useRef<"completed" | "skipped">("skipped");

  function persist(status: "completed" | "skipped") {
    // Fire-and-forget: this is a UI-state nicety, not a critical write the
    // user is blocked on. If it fails (network blip, session expired), the
    // dashboard is already fully usable regardless -- the tour just might
    // show again next visit, which is a minor inconvenience, not a defect
    // worth a loading/error state for.
    setOnboardingTourStatusAction(status).catch(() => {});
  }

  function open() {
    pendingStatusRef.current = "skipped";
    setStepIndex(0);
    setPhase("welcome");
  }

  function beginSteps() {
    setStepIndex(0);
    setPhase("step");
  }

  function next() {
    setStepIndex((i) => i + 1);
  }

  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  function skip() {
    pendingStatusRef.current = "skipped";
    persist("skipped");
    setPhase("closed");
  }

  function complete() {
    pendingStatusRef.current = "completed";
    persist("completed");
    setPhase("closed");
  }

  // Any dismissal that isn't the deliberate "finished the last step"
  // action (Escape, clicking the backdrop) must still record something,
  // or the tour would keep reappearing on every dashboard visit until
  // someone happens to click through to the very end -- exactly the "hard
  // requirement" this feature must not become. Treated the same as
  // clicking Kihagyom.
  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) return;
    if (pendingStatusRef.current === "completed") {
      // complete() already persisted and closed; nothing further to do.
      return;
    }
    skip();
  }

  return (
    <TourContext.Provider
      value={{ phase, stepIndex, open, next, back, beginSteps, skip, complete }}
    >
      {children}
      <TourDialog
        phase={phase}
        stepIndex={stepIndex}
        onOpenChange={handleOpenChange}
      />
    </TourContext.Provider>
  );
}
