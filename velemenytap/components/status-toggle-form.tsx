"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";

export type StatusToggleResult = { error?: string };

/**
 * Shared activate/deactivate control for locations and NFC cards. Ported
 * from an independent product audit (2026-09-08).
 *
 * The previous inline forms fired a Server Action and rendered nothing back:
 * a failed toggle looked identical to a successful one, so an owner who
 * "deactivated" a card had no way to know it was still live. This surfaces
 * both the pending state and the returned error.
 */
export function StatusToggleForm({
  id,
  status,
  action,
}: {
  id: number;
  status: "active" | "inactive";
  action: (formData: FormData) => Promise<StatusToggleResult>;
}) {
  const [state, formAction, pending] = useActionState(
    async (
      _previous: StatusToggleResult,
      formData: FormData,
    ): Promise<StatusToggleResult> => {
      try {
        return await action(formData);
      } catch (err) {
        // next/navigation's redirect() works by throwing; rethrow it
        // unchanged rather than reporting a navigation as a save failure.
        if (
          err &&
          typeof err === "object" &&
          "digest" in err &&
          typeof err.digest === "string" &&
          err.digest.startsWith("NEXT_REDIRECT")
        ) {
          throw err;
        }
        return { error: "Nem sikerült menteni az állapotot. Próbáld újra." };
      }
    },
    {},
  );

  return (
    <form action={formAction} className="max-w-56 space-y-1">
      <input type="hidden" name="id" value={id} />
      <input
        type="hidden"
        name="status"
        value={status === "active" ? "inactive" : "active"}
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending
          ? "Mentés..."
          : status === "active"
            ? "Deaktiválás"
            : "Aktiválás"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs whitespace-normal text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
