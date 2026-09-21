import { BillingAlertForm, BillingModeForm } from "@/features/platform-admin/billing-forms";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getPlatformAdmin } from "@/features/platform-admin/access";
import { PlatformLockForm } from "@/features/platform-admin/lock-form";
import { createAdminClient } from "@/lib/supabase/admin";
import { signOutAction } from "@/features/auth/actions";

export const metadata: Metadata = { title: "Tulajdonosi admin — VéleményTap", robots: { index: false, follow: false } };
const PAGE_SIZE = 25;
function pageNumber(value?: string) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 100000 ? n : 1;
}
function searchPattern(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

export default async function PlatformAdminPage({ searchParams }: {
  searchParams: Promise<{ q?: string; org?: string; page?: string; card?: string }>;
}) {
  await connection();
  const actor = await getPlatformAdmin();
  if (!actor) notFound();
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 100);
  const cardSearch = (params.card ?? "").trim().slice(0, 100);
  const page = pageNumber(params.page);
  const orgId = Number(params.org);
  const hasOrg = Number.isSafeInteger(orgId) && orgId > 0;
  const admin = createAdminClient();
  const [settingsResult, noticesResult, reviewResult] = await Promise.all([
    admin.from("billing_monitor_settings").select("enabled, recipient").eq("id", true).single(),
    admin.from("billing_owner_notices").select("id, organization_id, message, sent_at, last_error, needs_review, created_at").order("id", { ascending: false }).limit(10),
    admin.from("billing_owner_notices").select("id", { count: "exact", head: true }).eq("needs_review", true),
  ]);
  if (settingsResult.error || noticesResult.error || reviewResult.error) throw new Error("A fizetésfigyelő adatai nem tölthetők be.");
  let query = admin.from("organizations").select("id, name, slug", { count: "exact" }).order("name").order("id");
  if (hasOrg) query = query.eq("id", orgId);
  else if (q) query = query.ilike("name", searchPattern(q));
  const orgs = await query.range(hasOrg ? 0 : (page - 1) * PAGE_SIZE, hasOrg ? 0 : page * PAGE_SIZE - 1);
  if (orgs.error) throw new Error("A vállalkozások nem tölthetők be.");
  const selectedOrg = hasOrg ? orgs.data?.[0] : null;
  if (hasOrg && !selectedOrg) notFound();
  const controlResult = selectedOrg ? await admin.from("billing_card_controls").select("*").eq("organization_id", selectedOrg.id).single() : null;
  if (controlResult?.error) throw new Error("A fizetési mód nem olvasható.");
  const control = controlResult?.data;
  const stateNames: Record<string, string> = { unknown: "Ellenőrzés szükséges – nincs friss, teljes fizetési adat", ok: "Rendezett hozzáférés", attention: "Fizetési probléma, de még érvényes hozzáférés", grace: "Türelmi idő", overdue: "Türelmi idő lejárt – kézi intézkedés", blocked: "Automatikus fizetési tiltás" };
  let cards = null;
  let audit = null;
  if (selectedOrg) {
    let cardsQuery = admin.from("nfc_cards")
      .select("id, display_name, public_id, status, platform_locked, platform_previous_status, locations(name, status)", { count: "exact" })
      .eq("organization_id", selectedOrg.id).order("id", { ascending: false });
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardSearch)) cardsQuery = cardsQuery.eq("public_id", cardSearch);
    else if (cardSearch) cardsQuery = cardsQuery.ilike("display_name", searchPattern(cardSearch));
    const [cardResult, auditResult] = await Promise.all([
      cardsQuery.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
      admin.from("platform_card_audit").select("id, card_id, actor_id, locked, reason, created_at")
        .eq("organization_id", selectedOrg.id).order("id", { ascending: false }).limit(20),
    ]);
    if (cardResult.error || auditResult.error) throw new Error("A kártyák vagy a műveleti napló nem tölthető be.");
    cards = cardResult; audit = auditResult.data;
  }
  const total = (hasOrg ? cards?.count : orgs.count) ?? 0;
  const pageUrl = (nextPage: number) => `/admin?${new URLSearchParams({ ...(hasOrg ? { org: String(orgId), card: cardSearch } : { q }), page: String(nextPage) })}`;
  return (
    <main className="mx-auto max-w-5xl space-y-7 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-sm text-muted-foreground">VéleményTap · csak platform-adminisztrátoroknak</p><h1 className="text-3xl font-semibold">Tulajdonosi admin</h1><p className="mt-1 break-all text-sm">{actor.email}</p></div>
        <div className="flex gap-4 text-sm"><Link href="/dashboard" className="underline">Saját irányítópult</Link><form action={signOutAction}><button className="underline">Kijelentkezés</button></form></div>
      </header>
      <p className="rounded-lg border bg-muted/40 p-4 text-sm">Itt minden ügyfél vállalkozásának kártyáit kezelheted. A tulajdonosi zárolást az ügyfél nem oldhatja fel. A link és a visszajelzések megmaradnak; feloldáskor a zárolás előtti kártyaállapot áll vissza.</p>
      {!!reviewResult.count && <p role="alert" className="rounded-lg border border-destructive p-4 text-sm text-destructive">{reviewResult.count} fizetési értesítés küldési eredménye kézi ellenőrzést igényel. Kérj technikai segítséget a szolgáltatói napló ellenőrzéséhez.</p>}
      <BillingAlertForm enabled={settingsResult.data.enabled} recipient={settingsResult.data.recipient} email={actor.email ?? ""} />
      {selectedOrg ? <>
        <Link href="/admin" className="inline-block text-sm underline">← Összes vállalkozás</Link>
        <h2 className="break-words text-2xl font-semibold">{selectedOrg.name}</h2>
        <p className="text-sm text-muted-foreground">Vállalkozás #{selectedOrg.id} · {selectedOrg.slug}</p>
        {control && <section className="space-y-4 rounded-xl border p-5">
          <h3 className="text-xl font-semibold">Fizetésfigyelő és automatikus zárolás</h3>
          <p className="font-medium">{stateNames[control.state] ?? control.state}</p>
          <p className="text-sm">Fizetési tiltás: {control.blocked ? "érvényben – minden kártyalink inaktív" : "nincs"}. A kézi kártyazárolások ettől függetlenek.</p>
          <p className="text-sm">Utolsó kiértékelés: {control.checked_at ? new Date(control.checked_at).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }) : "még nem történt"}</p>
          {control.overdue_since && <p className="text-sm">Türelmi idő vége: {new Date(new Date(control.overdue_since).getTime() + control.grace_days * 86400000).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</p>}
          <p className="text-sm text-muted-foreground">Az ütemezett ellenőrzés célzottan 15 percenként fut; a szolgáltatók késése miatt nem azonnali. Fizetési szolgáltatói hiba nem indít új tiltást. Rendezett hozzáférésnél a fizetési tiltás automatikusan feloldódik.</p>
          <BillingModeForm key={`${control.organization_id}-${control.revision}`} organizationId={control.organization_id} mode={control.mode} graceDays={control.grace_days} revision={control.revision} />
        </section>}
        <form className="flex flex-wrap gap-2">
          <input type="hidden" name="org" value={selectedOrg.id} />
          <label className="min-w-0 flex-1">Kártyanév vagy nyilvános azonosító<input name="card" defaultValue={cardSearch} maxLength={100} className="mt-1 block w-full rounded-md border px-3 py-2" /></label>
          <button className="self-end rounded-md border px-4 py-2">Keresés</button>
        </form>
        <p className="text-sm">{total} kártya · {page}. oldal</p>
        <div className="space-y-4">{cards?.data?.map(card => (
          <article key={card.id} className="space-y-4 rounded-xl border p-5">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{card.display_name || "Névtelen kártya"} <span className="font-normal text-muted-foreground">#{card.id}</span></h3><strong className={card.platform_locked || control?.blocked ? "text-destructive" : "text-muted-foreground"}>{card.platform_locked ? "Tulajdonos által zárolva" : control?.blocked ? "Fizetés miatt leállítva" : card.status === "active" ? "Aktív" : "Ügyfél által inaktív"}</strong></div>
            <p className="text-sm">{card.locations?.name} · Helyszín: {card.locations?.status === "active" ? "aktív" : "inaktív"}</p>
            <Link href={`/r/${card.public_id}`} target="_blank" rel="noopener noreferrer" className="block break-all text-sm underline">Nyilvános oldal: /r/{card.public_id}</Link>
            {card.platform_locked && <p className="text-sm">Feloldás után: {card.platform_previous_status === "active" ? "aktív" : "inaktív"}. Az inaktív helyszín ettől még nem aktiválódik.</p>}
            <PlatformLockForm key={`${card.id}-${card.platform_locked}`} cardId={card.id} locked={card.platform_locked} />
          </article>
        ))}</div>
        {!cards?.data?.length && <p>Nincs a keresésnek megfelelő kártya.</p>}
      </> : <>
        <h2 className="text-xl font-semibold">Ügyfelek vállalkozásai</h2>
        <form className="flex flex-wrap gap-2"><label className="min-w-0 flex-1">Vállalkozás neve<input name="q" defaultValue={q} maxLength={100} className="mt-1 block w-full rounded-md border px-3 py-2" /></label><button className="self-end rounded-md border px-4 py-2">Keresés</button></form>
        <p className="text-sm">{total} vállalkozás · {page}. oldal</p>
        <div className="space-y-3">{orgs.data?.map(org => <Link key={org.id} href={`/admin?org=${org.id}`} className="block rounded-lg border p-4 hover:bg-muted"><strong className="break-words">{org.name}</strong><span className="mt-1 block break-all text-sm text-muted-foreground">#{org.id} · {org.slug} · Kártyák megnyitása →</span></Link>)}</div>
        {!orgs.data?.length && <p>Nincs a keresésnek megfelelő vállalkozás.</p>}
      </>}
      {!!noticesResult.data.length && <section className="space-y-3 border-t pt-5"><h2 className="text-xl font-semibold">Legutóbbi fizetési értesítések</h2>{noticesResult.data.map(n => <article key={n.id} className="rounded-lg border p-3 text-sm"><p className="font-semibold">#{n.organization_id} · {n.sent_at ? "E-mail-szolgáltató átvette" : n.needs_review ? "Kézi ellenőrzés szükséges" : "Küldésre vár"}</p><p className="whitespace-pre-line">{n.message}</p>{n.last_error && <p className="text-destructive">{n.last_error}</p>}</article>)}</section>}
      <nav aria-label="Lapozás" className="flex gap-5 text-sm">{page > 1 && <Link className="underline" href={pageUrl(page - 1)}>Előző oldal</Link>}{page * PAGE_SIZE < total && <Link className="underline" href={pageUrl(page + 1)}>Következő oldal</Link>}</nav>
      {selectedOrg && <section className="space-y-3 border-t pt-6"><h2 className="text-xl font-semibold">Legutóbbi 20 zárolási művelet</h2>{audit?.length ? audit.map(entry => <div key={entry.id} className="rounded-lg bg-muted/40 p-3 text-sm"><p className="font-medium">Kártya #{entry.card_id} · {entry.locked ? "Zárolva" : "Feloldva"} · {new Date(entry.created_at).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</p><p className="whitespace-pre-wrap break-words">{entry.reason}</p><p className="break-all text-xs text-muted-foreground">Adminisztrátor: {entry.actor_id}</p></div>) : <p className="text-sm">Még nincs zárolási művelet.</p>}</section>}
    </main>
  );
}
