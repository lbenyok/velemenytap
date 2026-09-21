import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Building2, CreditCard, ShieldCheck, Users, Bell, ArrowUpRight, LayoutDashboard, LockKeyhole } from "lucide-react";
import { getPlatformAdmin } from "@/features/platform-admin/access";
import { PlatformLockForm } from "@/features/platform-admin/lock-form";
import { BillingAlertForm, BillingModeForm } from "@/features/platform-admin/billing-forms";
import { ModeratorForm } from "@/features/platform-admin/team-form";
import { createAdminClient } from "@/lib/supabase/admin";
import { signOutAction } from "@/features/auth/actions";

export const metadata: Metadata = { title: "Kezelőközpont — VéleményTap", robots: { index: false, follow: false } };
const PAGE_SIZE = 25;
const panel = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6";
const input = "mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100";
const stateNames: Record<string, string> = { unknown: "Ellenőrzés szükséges", ok: "Rendezett hozzáférés", attention: "Fizetési probléma, még érvényes hozzáférés", grace: "Türelmi idő", overdue: "Türelmi idő lejárt – kézi intézkedés", blocked: "Automatikus fizetési tiltás" };
const subscriptionNames: Record<string, string> = { active: "Aktív előfizetés", trialing: "Próbaidő", past_due: "Elmaradt fizetés", canceled: "Lemondott", incomplete: "Befejezetlen fizetés", incomplete_expired: "Lejárt fizetési kísérlet", unpaid: "Nem fizetett", paused: "Szüneteltetett" };
const date = (v: string | null) => v ? new Date(v).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }) : "—";
function pageNumber(value?: string) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 100000 ? n : 1; }
function searchPattern(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

export default async function PlatformAdminPage({ searchParams }: { searchParams: Promise<{ q?: string; org?: string; page?: string; card?: string; view?: string }> }) {
  await connection();
  const actor = await getPlatformAdmin();
  if (!actor) notFound();
  const owner = actor.platformRole === "owner";
  const params = await searchParams;
  const view = ["customers", "payments", "team", "alerts"].includes(params.view ?? "") ? params.view! : "customers";
  if (!owner && (view === "team" || view === "alerts")) notFound();
  const q = (params.q ?? "").trim().slice(0, 100);
  const cardSearch = (params.card ?? "").trim().slice(0, 100);
  const page = pageNumber(params.page);
  const orgId = Number(params.org);
  const hasOrg = Number.isSafeInteger(orgId) && orgId > 0;
  const admin = createAdminClient();
  const [orgCount, cardCount, holdCount, manualCount] = await Promise.all([
    admin.from("organizations").select("id", { count: "exact", head: true }),
    admin.from("nfc_cards").select("id", { count: "exact", head: true }),
    admin.from("billing_card_controls").select("organization_id", { count: "exact", head: true }).eq("blocked", true),
    admin.from("nfc_cards").select("id", { count: "exact", head: true }).eq("platform_locked", true),
  ]);
  if ([orgCount,cardCount,holdCount,manualCount].some(r => r.error)) throw new Error("Az összesítés nem tölthető be.");
  let query = admin.from("organizations").select("id, name, slug", { count: "exact" }).order("name").order("id");
  if (hasOrg) query = query.eq("id", orgId); else if (q) query = query.ilike("name", searchPattern(q));
  const orgs = await query.range(hasOrg ? 0 : (page - 1) * PAGE_SIZE, hasOrg ? 0 : page * PAGE_SIZE - 1);
  if (orgs.error) throw new Error("A vállalkozások nem tölthetők be.");
  const selectedOrg = hasOrg ? orgs.data?.[0] : null;
  if (hasOrg && !selectedOrg) notFound();
  const ids = orgs.data.map(o => o.id);
  const [billing, controls] = ids.length ? await Promise.all([
    admin.from("organization_billing").select("organization_id,status,trial_ends_at,current_period_end,cancel_at_period_end,last_synced_at,stripe_subscription_id").in("organization_id", ids),
    admin.from("billing_card_controls").select("*").in("organization_id", ids),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (billing.error || controls.error) throw new Error("A fizetési állapot nem olvasható.");
  const control = controls.data?.find(c => c.organization_id === selectedOrg?.id);
  const selectedBilling = billing.data?.find(b => b.organization_id === selectedOrg?.id);
  let cards = null; let audit = null;
  if (selectedOrg) {
    let cardsQuery = admin.from("nfc_cards").select("id, display_name, public_id, status, platform_locked, platform_previous_status, locations(name, status)", { count: "exact" }).eq("organization_id", selectedOrg.id).order("id", { ascending: false });
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardSearch)) cardsQuery = cardsQuery.eq("public_id", cardSearch);
    else if (cardSearch) cardsQuery = cardsQuery.ilike("display_name", searchPattern(cardSearch));
    const [cardResult, auditResult] = await Promise.all([
      cardsQuery.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
      admin.from("platform_card_audit").select("id, card_id, actor_id, locked, reason, created_at").eq("organization_id", selectedOrg.id).order("id", { ascending: false }).limit(20),
    ]);
    if (cardResult.error || auditResult.error) throw new Error("A kártyák vagy a műveleti napló nem tölthető be.");
    cards = cardResult; audit = auditResult.data;
  }
  const settings = owner && view === "alerts" ? await admin.from("billing_monitor_settings").select("enabled, recipient").eq("id", true).single() : null;
  const notices = owner && view === "alerts" ? await admin.from("billing_owner_notices").select("id,organization_id,message,sent_at,last_error,needs_review,created_at").order("id", { ascending: false }).limit(20) : null;
  const reviews = owner ? await admin.from("billing_owner_notices").select("id", { count: "exact", head: true }).eq("needs_review", true) : null;
  const team = owner && view === "team" ? await admin.rpc("get_platform_team", { p_actor_id: actor.id }) : null;
  if (settings?.error || notices?.error || reviews?.error || team?.error) throw new Error("A kezelői beállítások nem tölthetők be.");
  const total = (hasOrg ? cards?.count : orgs.count) ?? 0;
  const pageUrl = (n: number) => `/admin?${new URLSearchParams({ view, ...(hasOrg ? { org: String(orgId), card: cardSearch } : { q }), page: String(n) })}`;
  const navigation = [
    { view: "customers", label: "Ügyfelek és kártyák", icon: Building2 },
    { view: "payments", label: "Fizetések", icon: CreditCard },
    ...(owner ? [{ view: "team", label: "Csapat és jogosultságok", icon: Users }, { view: "alerts", label: "Értesítések", icon: Bell }] : []),
  ];
  return <div className="min-h-svh bg-slate-100 text-slate-900 [color-scheme:light] lg:pl-64">
    <aside className="flex flex-col bg-slate-950 px-5 py-6 text-white lg:fixed lg:inset-y-0 lg:left-0 lg:w-64">
      <Link href="/admin" className="flex items-center gap-3"><span className="rounded-xl bg-cyan-400 p-2 text-slate-950"><ShieldCheck className="size-6" /></span><span><strong className="block text-lg tracking-tight">VéleményTap</strong><span className="text-xs uppercase tracking-[.2em] text-slate-400">Kezelőközpont</span></span></Link>
      <p className="mt-8 hidden text-[11px] font-semibold uppercase tracking-[.16em] text-slate-500 lg:block">Működtetés</p>
      <nav aria-label="Adminisztráció" className="mt-4 flex flex-wrap gap-2 lg:flex-col">{navigation.map(item => <Link key={item.view} href={`/admin?view=${item.view}`} aria-current={view === item.view ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium ${view === item.view ? "bg-white/10 text-cyan-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><item.icon className="size-4" />{item.label}</Link>)}</nav>
      <div className="mt-6 border-t border-white/10 pt-5 lg:mt-auto"><p className="text-xs text-slate-400">Bejelentkezve mint</p><p className="mt-1 break-all text-sm">{actor.email}</p><span className="mt-3 inline-flex rounded-full border border-cyan-400/30 px-2.5 py-1 text-xs text-cyan-300">{owner ? "Tulajdonos" : "Moderátor"}</span><form action={signOutAction}><button className="mt-4 text-xs text-slate-400 hover:text-white">Kijelentkezés</button></form></div>
    </aside>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-5 sm:px-8"><div className="flex items-center gap-2 text-sm text-slate-500"><LayoutDashboard className="size-4" /><span>Adminisztráció</span><span>/</span><span className="font-medium text-slate-950">{navigation.find(n => n.view === view)?.label}</span></div><Link href="/dashboard" className="flex items-center gap-1 text-xs text-slate-500">Ügyféloldali nézet <ArrowUpRight className="size-3" /></Link></header>
    <main className="mx-auto max-w-7xl space-y-7 px-5 py-8 sm:px-8">
      <div><p className="text-xs font-semibold uppercase tracking-[.18em] text-cyan-700">{owner ? "Tulajdonosi áttekintés" : "Moderátori munkaterület"}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{owner ? "Tulajdonosi admin" : "Moderátori admin"}</h1><p className="mt-2 max-w-2xl text-sm text-slate-500">Ügyfelek, kártyák és előfizetések egy helyen. Minden kézi zárolás indoklással kerül a naplóba.</p></div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[{label:"Vállalkozások",value:orgCount.count,icon:Building2},{label:"NFC-kártyák",value:cardCount.count,icon:CreditCard},{label:"Fizetési tiltás alatt",value:holdCount.count,icon:ShieldCheck},{label:"Kézzel zárolt kártyák",value:manualCount.count,icon:LockKeyhole}].map(item => <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-2 text-slate-400"><span className="text-xs">{item.label}</span><item.icon className="size-4 shrink-0" /></div><p className="mt-3 text-3xl font-semibold tracking-tight">{item.value ?? 0}</p></div>)}</div>
      {!!reviews?.count && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{reviews.count} értesítés küldési eredményét ellenőrizni kell. <Link href="/admin?view=alerts" className="underline">Értesítések megnyitása</Link></p>}
      {view === "team" ? <>
        <section className={panel}><h2 className="text-xl font-semibold">Csapat és jogosultságok</h2><p className="my-3 max-w-2xl text-sm text-slate-500">A moderátor láthatja a vállalkozásokat, kártyákat és előfizetési állapotokat, valamint kézzel zárolhat és feloldhat kártyákat. Nem adhat hozzá más kezelőt, nem állíthat fizetési automatizmust, nem módosíthat értesítési címzettet, és nem indíthat fizetést vagy visszatérítést.</p><p className="mb-5 text-sm text-slate-500">Először regisztráljon a saját e-mail-címével, és erősítse meg azt. Utána itt adhatsz hozzáférést. Jelszót nem kell megosztanotok; külön meghívólevél nem készül.</p><ModeratorForm /></section>
        <section className={panel}><h2 className="mb-5 text-xl font-semibold">Hozzáféréssel rendelkezők</h2><div className="divide-y divide-slate-100">{team?.data?.map(member => <div key={member.user_id} className="flex flex-wrap items-center justify-between gap-4 py-4"><div><p className="break-all font-medium">{member.email}</p><p className="mt-1 text-xs text-slate-500">{member.role === "owner" ? "Tulajdonos – teljes kezelői hozzáférés" : "Moderátor – korlátozott kezelés"}</p></div>{member.role === "moderator" ? <ModeratorForm email={member.email} /> : <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs text-cyan-800">Védett tulajdonosi szerep</span>}</div>)}</div>{team?.data?.length === 100 && <p>Az első 100 kezelő látható.</p>}</section>
      </> : view === "alerts" ? <>
        {settings?.data && <BillingAlertForm enabled={settings.data.enabled} recipient={settings.data.recipient} email={actor.email ?? ""} />}
        <section className={panel}><h2 className="mb-5 text-xl font-semibold">Legutóbbi fizetési értesítések</h2><div className="space-y-3">{notices?.data?.map(n => <article key={n.id} className="rounded-xl border border-slate-200 p-4 text-sm"><p className="font-semibold">#{n.organization_id} · {n.sent_at ? "E-mail-szolgáltató átvette" : n.needs_review ? "Kézi ellenőrzés szükséges" : "Küldésre vár"}</p><p className="mt-2 whitespace-pre-line text-slate-600">{n.message}</p>{n.last_error && <p className="mt-2 text-red-700">{n.last_error}</p>}</article>)}</div>{!notices?.data?.length && <p className="text-sm text-slate-500">Még nincs fizetési értesítés.</p>}</section>
      </> : selectedOrg ? <>
        <Link href={`/admin?view=${view}`} className="text-sm font-medium text-cyan-700">← Vállalkozások</Link>
        <div><h2 className="break-words text-2xl font-semibold">{selectedOrg.name}</h2><p className="mt-1 text-sm text-slate-500">Vállalkozás #{selectedOrg.id} · {selectedOrg.slug}</p></div>
        <section className={panel}><h3 className="text-xl font-semibold">Előfizetés és kártyaállapot</h3><dl className="my-5 grid gap-4 text-sm sm:grid-cols-3"><div><dt className="text-slate-500">Előfizetés</dt><dd className="mt-1 font-medium">{selectedBilling ? subscriptionNames[selectedBilling.status] : "Nincs adat"}</dd></div><div><dt className="text-slate-500">Időszak vége / próba vége</dt><dd className="mt-1 font-medium">{date(selectedBilling?.current_period_end ?? selectedBilling?.trial_ends_at ?? null)}</dd></div><div><dt className="text-slate-500">Stripe-adatok frissítése</dt><dd className="mt-1 font-medium">{date(selectedBilling?.last_synced_at ?? null)}</dd></div></dl>{selectedBilling?.cancel_at_period_end && <p className="mb-4 text-sm text-amber-700">Lemondás az időszak végére beállítva.</p>}
          {control && <div className="space-y-4 border-t border-slate-100 pt-5"><p className="font-semibold">{stateNames[control.state]}</p><p className="text-sm text-slate-500">Fizetési tiltás: {control.blocked ? "érvényben – minden kártyalink inaktív" : "nincs"}. Kezelés: {control.mode === "automatic" ? "automatikus" : "kézi"}.</p><p className="text-sm text-slate-500">Utolsó kiértékelés: {date(control.checked_at)}</p>{control.overdue_since && <p className="text-sm">Türelmi idő vége: {date(new Date(new Date(control.overdue_since).getTime()+control.grace_days*86400000).toISOString())}</p>}{owner ? <BillingModeForm key={`${control.organization_id}-${control.revision}`} organizationId={control.organization_id} mode={control.mode} graceDays={control.grace_days} revision={control.revision} /> : <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">Az automatikus fizetési szabályokat csak a tulajdonos módosíthatja. Az alábbi egyedi kártyazárolásokat kezelheted.</p>}</div>}
        </section>
        <section className={panel}><div className="mb-5 flex items-center justify-between"><h3 className="text-xl font-semibold">Kártyák</h3><span className="text-sm text-slate-500">{total} kártya</span></div><form className="flex flex-wrap items-end gap-3"><input type="hidden" name="org" value={selectedOrg.id} /><input type="hidden" name="view" value={view} /><label className="min-w-0 flex-1 text-sm font-medium">Kártyanév vagy nyilvános azonosító<input name="card" defaultValue={cardSearch} maxLength={100} className={input} /></label><button className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-medium text-white">Keresés</button></form></section>
        <div className="space-y-4">{cards?.data?.map(card => <article key={card.id} className={panel}><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{card.display_name || "Névtelen kártya"} <span className="font-normal text-slate-400">#{card.id}</span></h3><strong className={`rounded-full px-3 py-1 text-xs ${card.platform_locked || control?.blocked ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{card.platform_locked ? "Kézzel zárolva" : control?.blocked ? "Fizetés miatt leállítva" : card.status === "active" ? "Aktív" : "Ügyfél által inaktív"}</strong></div><p className="text-sm text-slate-500">{card.locations?.name} · Helyszín: {card.locations?.status === "active" ? "aktív" : "inaktív"}</p><Link href={`/r/${card.public_id}`} target="_blank" rel="noopener noreferrer" className="my-3 block break-all text-sm text-cyan-700 underline">Nyilvános oldal: /r/{card.public_id}</Link>{card.platform_locked && <p className="mb-4 text-sm text-slate-500">Feloldás után: {card.platform_previous_status === "active" ? "aktív" : "inaktív"}. Az inaktív helyszín vagy külön fizetési tiltás ettől nem oldódik fel.</p>}<PlatformLockForm key={`${card.id}-${card.platform_locked}`} cardId={card.id} locked={card.platform_locked} /></article>)}</div>
        {!cards?.data?.length && <p className="text-sm text-slate-500">Nincs a keresésnek megfelelő kártya.</p>}
        <section className={panel}><h3 className="mb-5 text-xl font-semibold">Legutóbbi 20 zárolási művelet</h3><div className="space-y-3">{audit?.map(entry => <div key={entry.id} className="border-l-2 border-cyan-500 pl-4 text-sm"><p className="font-medium">Kártya #{entry.card_id} · {entry.locked ? "Zárolva" : "Feloldva"} · {date(entry.created_at)}</p><p className="mt-1 whitespace-pre-wrap break-words text-slate-500">{entry.reason}</p><p className="mt-1 break-all text-xs text-slate-400">Kezelő: {entry.actor_id}</p></div>)}</div>{!audit?.length && <p className="text-sm text-slate-500">Még nincs zárolási művelet.</p>}</section>
      </> : <section className={panel}>
        <div className="mb-5"><h2 className="text-xl font-semibold">{view === "payments" ? "Előfizetések és fizetési állapot" : "Ügyfelek vállalkozásai"}</h2><p className="mt-1 text-sm text-slate-500">{view === "payments" ? "A szinkronizált előfizetési állapot látható; ez nem banki tranzakciólista." : "Keress vállalkozást, majd nyisd meg a kártyáit és a kezelési naplót."}</p></div>
        <form className="mb-6 flex flex-wrap items-end gap-3"><input type="hidden" name="view" value={view} /><label className="min-w-0 flex-1 text-sm font-medium">Vállalkozás neve<input name="q" defaultValue={q} maxLength={100} className={input} /></label><button className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-medium text-white">Keresés</button></form>
        <p className="mb-3 text-xs text-slate-400">{total} vállalkozás · {page}. oldal</p>
        <div className="divide-y divide-slate-100">{orgs.data.map(org => { const b=billing.data?.find(b=>b.organization_id===org.id);const c=controls.data?.find(c=>c.organization_id===org.id);return <Link key={org.id} href={`/admin?view=${view}&org=${org.id}`} className="grid items-center gap-3 rounded-lg px-2 py-5 transition-colors hover:bg-slate-50 sm:grid-cols-[1.4fr_1fr_auto]"><div><strong className="block break-words">{org.name}</strong><span className="mt-1 block text-xs text-slate-400">#{org.id} · {org.slug}</span></div><div className="text-sm"><p>{b ? subscriptionNames[b.status] : "Nincs fizetési adat"}</p><p className="mt-1 text-xs text-slate-400">{view === "payments" ? `Időszak vége: ${date(b?.current_period_end ?? b?.trial_ends_at ?? null)}` : c ? stateNames[c.state] : "Ellenőrzés szükséges"}</p></div><span className={`rounded-full px-3 py-1 text-xs ${c?.blocked ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-500"}`}>{c?.blocked ? "Fizetési tiltás" : "Megnyitás →"}</span></Link>;})}</div>{!orgs.data.length && <p className="py-6 text-center text-sm text-slate-500">Nincs a keresésnek megfelelő vállalkozás.</p>}
      </section>}
      {(view === "customers" || view === "payments") && <nav aria-label="Lapozás" className="flex gap-5 text-sm font-medium text-cyan-700">{page > 1 && <Link href={pageUrl(page-1)}>← Előző oldal</Link>}{page*PAGE_SIZE < total && <Link href={pageUrl(page+1)}>Következő oldal →</Link>}</nav>}
    </main>
  </div>;
}
