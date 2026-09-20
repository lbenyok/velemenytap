"use client";

import { useActionState } from "react";
import { setPlatformCardLockAction } from "./actions";

export function PlatformLockForm({ cardId, locked }: { cardId: number; locked: boolean }) {
  const [state, action, pending] = useActionState(setPlatformCardLockAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="cardId" value={cardId} />
      <input type="hidden" name="locked" value={String(!locked)} />
      <input type="hidden" name="expected" value={String(locked)} />
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        Indoklás (a belső naplóba)
        <input name="reason" required minLength={2} maxLength={500} disabled={pending}
          className="rounded-md border bg-background px-3 py-2" placeholder="Például: elveszett kártya" />
      </label>
      <button disabled={pending} type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {pending ? "Mentés…" : locked ? "Zárolás feloldása" : "Kártya zárolása"}
      </button>
      {state.error && <p role="alert" className="w-full text-sm text-destructive">{state.error}</p>}
      {state.success && <p role="status" className="w-full text-sm">A zárolás módosítása mentve.</p>}
    </form>
  );
}
