"use client";

import { CircleHelp } from "lucide-react";
import { useTour } from "./tour-provider";
import { Button } from "@/components/ui/button";

/**
 * The one required, always-reachable way back into the tour after it's
 * been completed or skipped. Icon-only at every width (not just below
 * `sm`, unlike the sign-out button next to it) -- the header row's width
 * budget is already tightly tuned (round-4 R4-06, round-5 R5-07; see
 * dashboard-nav.tsx), so this adds the smallest possible fixed footprint
 * rather than reopening that fight for a rarely-used control.
 */
export function ReopenTourButton() {
  const { open } = useTour();
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Útmutató megnyitása" onClick={open}>
      <CircleHelp className="size-4" aria-hidden="true" />
    </Button>
  );
}
