"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { setOnboardingTourStatusAction } from "./actions";
import { TourDialog } from "./tour-dialog";
import type { OnboardingTourStatus } from "@/lib/supabase/database.types";

type TourPhase = "closed" | "welcome" | "step";

/** Tracks an in-flight or failed attempt to close the dialog with a given
 * status -- while this is non-null, the dialog stays open and shows either
 * a saving indicator or a retry/close-anyway prompt, never silently
 * discarding the fact that the write hasn't been confirmed yet.
 *
 * `navigateTo` carries the final step's own action-button intent (e.g.
 * "Helyszín hozzáadása" -> /dashboard/locations) across a failed attempt
 * and into a later retry. It has to live here, not as a local variable
 * where the button click originated, because "Próbáld újra" calls this
 * same pending attempt back through `retry()` below -- not back through
 * the button -- so the original intent would otherwise be lost the moment
 * the first attempt fails. Every other close path (Kihagyom, Escape,
 * backdrop, the ordinary Bezárás button) passes null here and never
 * navigates, on the first attempt or any retry of it. */
type PendingClose = {
  status: "completed" | "skipped";
  saving: boolean;
  error: string | null;
  navigateTo: string | null;
};

type TourContextValue = {
  phase: TourPhase;
  stepIndex: number;
  pending: PendingClose | null;
  /** Opens from the welcome screen -- used both for the automatic
   * first-time show and for the manual "Útmutató megnyitása" reopen
   * button, which is exactly why reopening never touches the persisted
   * status by itself: it's the same entry point either way, and nothing
   * is written until the tour is dismissed or finished again. */
  open: () => void;
  next: () => void;
  back: () => void;
  beginSteps: () => void;
  /** Attempts to record "skipped" and close -- used by the Kihagyom
   * button and by any implicit dismissal (Escape, backdrop click). Stays
   * open with an error/retry prompt if the write fails; never silently
   * closes on a failed save. */
  skip: () => void;
  /** Attempts to record "completed" and close -- used by both the final
   * step's ordinary Bezárás button (no argument) and its own action
   * button ("Helyszín hozzáadása", passing the href it should navigate to
   * once the write is actually confirmed -- including via a later retry,
   * not just this immediate call). Returns whether it actually
   * succeeded. */
  complete: (navigateTo?: string | null) => Promise<boolean>;
  /** Retries the currently pending (failed) close attempt. */
  retry: () => void;
  /** Gives up on persisting the pending close attempt and closes anyway --
   * a deliberate, informed choice, not a silent failure: the tour may
   * simply reappear later, which is honest given the write never actually
   * confirmed. */
  closeAnyway: () => void;
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
  const [pending, setPending] = useState<PendingClose | null>(null);
  const router = useRouter();
  // This client's best understanding of the persisted status -- seeded
  // from the server-rendered value, updated only after a confirmed
  // successful write. Purely a client-side optimization (skips an
  // unnecessary network call for an already-known-terminal state); the
  // actual guarantee that "completed" can never be downgraded is enforced
  // by the UPDATE's own WHERE clause in actions.ts against the database's
  // real current value, not against this ref, so a stale ref here (e.g.
  // another device completed the tour since this page loaded) can never
  // cause an incorrect downgrade.
  const lastKnownStatusRef = useRef<OnboardingTourStatus>(initialStatus);

  function open() {
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

  async function attemptClose(
    status: "completed" | "skipped",
    navigateTo: string | null,
  ): Promise<boolean> {
    // Client-side mirror of the server's own terminal-state guard -- avoids
    // an unnecessary request for the common "reopened a completed tour,
    // dismissed it again" case. Not load-bearing for correctness (the
    // server enforces this regardless), just avoids the round trip.
    if (lastKnownStatusRef.current === status || lastKnownStatusRef.current === "completed") {
      setPending(null);
      setPhase("closed");
      if (navigateTo) router.push(navigateTo);
      return true;
    }

    setPending({ status, saving: true, error: null, navigateTo });
    // A Server Action call rejects (rather than resolving with `{ error }`)
    // on a genuine network failure -- a dropped connection, a timeout, the
    // server process itself erroring before the function body ever runs.
    // That's a different failure mode from the function body deliberately
    // returning `{ error }`, but from here it means the same thing: the
    // write is not confirmed, so it gets the identical retry/close-anyway
    // treatment rather than an uncaught rejection surfacing as a React
    // error boundary and losing the tour's state entirely.
    let result: { error?: string };
    try {
      result = await setOnboardingTourStatusAction(status);
    } catch {
      setPending({ status, saving: false, error: "Nem sikerült menteni az útmutató állapotát.", navigateTo });
      return false;
    }
    if (result.error) {
      setPending({ status, saving: false, error: result.error, navigateTo });
      return false;
    }
    lastKnownStatusRef.current = status;
    setPending(null);
    setPhase("closed");
    // Navigating here, rather than back at whatever call site originally
    // triggered this attempt, is what makes a later retry (which re-enters
    // this same function through `retry()`, carrying `pending.navigateTo`
    // forward) still navigate on eventual success -- the call site itself
    // is long gone by the time a retry succeeds.
    if (navigateTo) router.push(navigateTo);
    return true;
  }

  function skip() {
    void attemptClose("skipped", null);
  }

  function complete(navigateTo: string | null = null): Promise<boolean> {
    return attemptClose("completed", navigateTo);
  }

  function retry() {
    if (pending) {
      void attemptClose(pending.status, pending.navigateTo);
    }
  }

  function closeAnyway() {
    setPending(null);
    setPhase("closed");
  }

  // Any dismissal that isn't the deliberate "finished the last step"
  // action (Escape, clicking the backdrop) must still attempt to record
  // something, or the tour would keep reappearing on every dashboard visit
  // until someone happens to click through to the very end -- exactly the
  // "hard requirement" this feature must not become. Treated the same as
  // clicking Kihagyom. While a close attempt is pending (saving, or
  // showing a retry prompt after a failure), a further implicit dismissal
  // is ignored -- the dialog stays open until the user makes an explicit
  // choice (retry or close anyway), rather than silently abandoning an
  // in-flight or failed write.
  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) return;
    if (pending) return;
    skip();
  }

  return (
    <TourContext.Provider
      value={{ phase, stepIndex, pending, open, next, back, beginSteps, skip, complete, retry, closeAnyway }}
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
