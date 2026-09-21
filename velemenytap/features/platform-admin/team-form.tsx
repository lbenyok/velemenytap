"use client";
import { useActionState } from "react";
import { setModeratorAction } from "./team-actions";

export function ModeratorForm({ email }: { email?: string }) {
  const [state, action, pending] = useActionState(setModeratorAction, {});
  return <form action={action} className="space-y-3">
    <input type="hidden" name="enabled" value={email ? "false" : "true"} />
    {email ? <input type="hidden" name="email" value={email} /> : <label className="block text-sm font-medium text-slate-700">Új moderátor e-mail-címe
      <input required type="email" name="email" maxLength={320} placeholder="nev@pelda.hu" disabled={pending} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950" />
    </label>}
    <button disabled={pending} className={email ? "rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50" : "rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"}>
      {pending ? "Mentés…" : email ? "Hozzáférés visszavonása" : "Moderátor hozzáadása"}
    </button>
    {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    {state.success && <p role="status" className="text-sm text-emerald-700">{state.success}</p>}
  </form>;
}
