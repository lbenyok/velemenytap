"use client";
import { useActionState } from "react";
import { checkBillingNowAction, saveBillingAlertSettingsAction, saveBillingCardModeAction } from "./billing-actions";

const button = "rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50";
function Result({ state }: { state: { error?: string; success?: string } }) {
  return <>{state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}{state.success && <p role="status" className="text-sm">{state.success}</p>}</>;
}
export function BillingAlertForm({ enabled, email, recipient }: { enabled: boolean; email: string; recipient: string | null }) {
  const [state, action, pending] = useActionState(saveBillingAlertSettingsAction, {});
  return <form action={action} className="space-y-3 rounded-xl border p-5">
    <h2 className="text-xl font-semibold">Tulajdonosi fizetési értesítések</h2>
    <p className="text-sm">Állapotváltozáskor értesítünk: fizetési probléma, lejárt próbaidő, automatikus tiltás vagy rendezett hozzáférés. Nem küldünk levelet minden ellenőrzésnél.</p>
    <p className="text-sm break-all">Jelenlegi címzett: {recipient || "még nincs beállítva"}. Mentéskor a te címed lesz: {email}.</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={enabled} disabled={pending} />E-mailes értesítések bekapcsolva</label>
    <button className={button} disabled={pending}>{pending ? "Mentés…" : "Értesítések mentése"}</button><Result state={state} />
  </form>;
}
export function BillingModeForm({ organizationId, mode, graceDays, revision }: { organizationId: number; mode: string; graceDays: number; revision: number }) {
  const [state, action, pending] = useActionState(saveBillingCardModeAction, {});
  const [check, checkAction, checking] = useActionState(checkBillingNowAction, {});
  return <div className="space-y-4">
    <form action={action} className="space-y-3">
      <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="revision" value={revision} />
      <label className="block text-sm">Nemfizetés kezelése<select className="mt-1 block w-full rounded-md border bg-background p-2" name="mode" defaultValue={mode} disabled={pending}><option value="manual">Kézi – értesítés, én zárolom a kártyákat</option><option value="automatic">Automatikus – a türelmi idő után minden kártyalink tiltása</option></select></label>
      <label className="block text-sm">Türelmi idő (nap)<input className="mt-1 block rounded-md border p-2" type="number" name="graceDays" min={0} max={30} defaultValue={graceDays} required disabled={pending} /></label>
      <p className="text-sm">Az idő az első igazolt jogosultsághiánytól számít. Ha már lejárt, az automatikus mód bekapcsolása azonnal tilthat. Kézi módra váltva a fizetési tiltás megszűnik, az egyedi kézi zárolások megmaradnak.</p>
      <button className={button} disabled={pending}>{pending ? "Mentés…" : "Fizetési mód mentése"}</button><Result state={state} />
    </form>
    <form action={checkAction} className="space-y-2"><input type="hidden" name="organizationId" value={organizationId} /><button className="rounded-md border px-4 py-2 text-sm disabled:opacity-50" disabled={checking}>{checking ? "Ellenőrzés…" : "Fizetés ellenőrzése most"}</button><Result state={check} /></form>
  </div>;
}
