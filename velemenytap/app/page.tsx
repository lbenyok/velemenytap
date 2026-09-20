import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { Nfc, Mail, Inbox, BarChart3, ArrowRight, Check } from "lucide-react";
import { RatingDemo } from "@/features/marketing/rating-demo";
import { cn } from "@/lib/utils";
import { PLAN_PRICING } from "@/features/billing/plans";

export const metadata: Metadata = {
  title: "VéleményTap — egy érintés, értékes visszajelzés",
  description:
    "Gyűjts vendégvéleményeket NFC-kártyával, kövesd őket egy átlátható irányítópulton, és kapj e-mailt az 1–3 csillagos visszajelzésekről. VéleményTap: 14 napos próba bankkártya nélkül.",
};

const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const VERTICALS = [
  "Kávézók és éttermek",
  "Szalonok és wellness-stúdiók",
  "Rendelők és klinikák",
  "Edzőtermek és stúdiók",
  "Üzletek",
  "Szolgáltató vállalkozások",
];

const STEPS = [
  {
    n: "01",
    title: "Tedd kézközelbe a kártyát",
    body: "A pulton, az asztalon vagy a recepción: a vendég NFC-képes telefonjával megnyitja az értékelőoldaladat. A visszajelzéshez nem kell alkalmazást telepítenie vagy fiókot létrehoznia.",
  },
  {
    n: "02",
    title: "Kérj visszajelzést, amíg friss az élmény",
    body: "A vendég csillagokkal értékel, majd elküldi a véleményét. Alacsony értékelésnél szövegesen is elmondhatja, min javítana. A beállított Google-értékelési oldal is elérhető a folyamatból.",
  },
  {
    n: "03",
    title: "Lásd, mi működik, és mire figyelj",
    body: "A beérkezett visszajelzéseket az irányítópulton követheted. Az 1–3 csillagos értékelésekről e-mailes jelzést kaphatsz, így könnyebb észrevenni, ha valami figyelmet igényel.",
  },
];

const DASHBOARD_CARDS = [
  {
    icon: Inbox,
    title: "Rend a visszajelzések között",
    body: "A VéleményTapon beküldött értékeléseket helyszín, kártya és állapot szerint szűrheted. Belső jegyzettel és státusszal követheted, melyikkel foglalkoztál már.",
  },
  {
    icon: Mail,
    title: "Jelzés, amikor figyelned kell",
    body: "Az 1–3 csillagos visszajelzésekről e-mailes értesítés segít tájékozódni. A vállalkozásodhoz külön, megerősített értesítési címet is megadhatsz.",
  },
  {
    icon: BarChart3,
    title: "Számok a benyomások mellé",
    body: "Kövesd az értékelések számát, átlagát és időbeli alakulását. Hasonlítsd össze a helyszíneket és a kártyákat a nálad beérkezett visszajelzések alapján.",
  },
  {
    icon: Nfc,
    title: "Kártyák, amelyeket te kezelsz",
    body: "Nevezd el a kártyáidat, rendeld őket helyszínhez, és szükség esetén deaktiváld őket az irányítópulton. Újraaktiváláskor a link és a korábbi visszajelzések megmaradnak.",
  },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pf-bg)]";

export default function HomePage() {
  return (
    <div
      className={cn(
        "public-feedback min-h-svh bg-[var(--pf-bg)] text-[var(--pf-ink)]",
        fraunces.variable,
      )}
    >
      <SiteNav />

      <main>
        <Hero />
        <ProofRow />
        <HowItWorks />
        <BuiltFor />
        <DashboardPreview />
        <Pricing />
        <Questions />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}

function SiteNav() {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-8">
      <span
        className="shrink-0 text-lg font-semibold tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Vélemény
        <span
          className="bg-clip-text text-transparent"
          style={{ backgroundImage: "var(--pf-accent-gradient-text)" }}
        >
          Tap
        </span>
      </span>
      <nav className="flex items-center gap-3 sm:gap-5">
        <Link
          href="/login"
          className={cn(
            "rounded-md text-sm text-[var(--pf-ink-muted)] transition-colors hover:text-[var(--pf-ink)]",
            FOCUS_RING,
          )}
        >
          Bejelentkezés
        </Link>
        <Link
          href="/signup"
          className={cn(
            "rounded-lg bg-[var(--pf-accent)] px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]",
            FOCUS_RING,
          )}
        >
          Kipróbálom
        </Link>
      </nav>
    </header>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-xs font-medium tracking-[0.14em] text-[var(--pf-accent)] uppercase">
      {children}
    </p>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-5 pt-8 pb-20 sm:px-8 sm:pt-14 sm:pb-28">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700">
          <Eyebrow>NFC-kártya + saját irányítópult</Eyebrow>
          <h1
            className="mt-4 text-4xl leading-[1.08] font-medium text-balance sm:text-5xl lg:text-[3.4rem]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Egy érintés a vendégednek.
            <br />
            <span
              className="bg-clip-text text-transparent italic"
              style={{ backgroundImage: "var(--pf-accent-gradient-text)" }}
            >
              Értékes visszajelzés neked.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-[var(--pf-ink-muted)] sm:text-lg">
            Ne hagyd, hogy a vendégeid véleménye elvesszen a napi pörgésben.
            Tedd egyszerűvé a visszajelzést egy NFC-kártyával, kövesd a beérkezett
            értékeléseket egy helyen, és vedd észre, hol teheted még jobbá a kiszolgálást.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-[var(--pf-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]",
                FOCUS_RING,
              )}
            >
              Kipróbálom 14 napig
              <ArrowRight className="size-4" strokeWidth={2} />
            </Link>
            <a
              href="#how-it-works"
              className={cn(
                "rounded-md text-sm font-medium text-[var(--pf-ink)] underline decoration-[var(--pf-line)] decoration-2 underline-offset-4 transition-colors hover:decoration-[var(--pf-accent)]",
                FOCUS_RING,
              )}
            >
              Így működik a VéleményTap
            </a>
          </div>
        </div>

        <div className="flex justify-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700 motion-safe:[animation-delay:150ms] motion-safe:fill-mode-both lg:justify-end">
          <RatingDemo />
        </div>
      </div>
    </section>
  );
}

function ProofRow() {
  return (
    <section className="border-y border-[var(--pf-line)] bg-[var(--pf-surface)]">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
        <Eyebrow>Kevesebb keresgélés, több odafigyelés</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          A kártyától az átlátható visszajelzésekig.
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {[
            { title: "Egyszerű a vendégnek", body: "Saját telefonján értékel, külön VéleményTap-fiók nélkül." },
            { title: "Átlátható neked", body: "A beküldött visszajelzések egy helyen, helyszínhez és kártyához kapcsolva." },
            { title: "Közvetlen út a Google-höz", body: "A saját Google-értékelési linkedet kapcsolhatod a vendégélményhez." },
          ].map(({ title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-bg)] p-5"
            >
              <Check className="mb-3 size-5 text-[var(--pf-accent)]" aria-hidden="true" />
              <h3 className="font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--pf-ink-muted)]">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <Eyebrow>Hogyan működik</Eyebrow>
      <h2
        className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Visszajelzés ott, ahol az élmény születik.
      </h2>
      <div className="mt-10 grid gap-8 sm:grid-cols-3 sm:gap-6">
        {STEPS.map((step) => (
          <div key={step.n}>
            <span
              className="text-3xl font-medium text-[var(--pf-line)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {step.n}
            </span>
            <h3 className="mt-2 text-lg font-medium">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--pf-ink-muted)]">
              {step.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BuiltFor() {
  return (
    <section className="border-y border-[var(--pf-line)] bg-[var(--pf-surface)]">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
        <Eyebrow>A mindennapi találkozásokhoz</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Ahol számít, hogyan távozik a vendég.
        </h2>
        <div className="mt-7 flex flex-wrap gap-2.5">
          {VERTICALS.map((v) => (
            <span
              key={v}
              className="rounded-full border border-[var(--pf-line)] bg-[var(--pf-bg)] px-4 py-2 text-sm text-[var(--pf-ink)]"
            >
              {v}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function DashboardPreview() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <Eyebrow>A csillagok mögött ott a lehetőség</Eyebrow>
      <h2
        className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Tudd, mire építhetsz. Lásd, min javíthatsz.
      </h2>
      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {DASHBOARD_CARDS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6"
          >
            <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--pf-accent)]/10 text-[var(--pf-accent)]">
              <Icon className="size-4.5" strokeWidth={2} />
            </div>
            <h3 className="mt-4 text-base font-medium">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--pf-ink-muted)]">
              {body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatHuf(amount: number) {
  // Deliberately not toLocaleString: this page is server-rendered and the
  // grouping separator must be the Hungarian thin space regardless of the
  // runtime's ICU data.
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")}\u00a0Ft`;
}

const PLAN_FEATURES = [
  "Több helyszín és kártya kezelése egy vállalkozáson belül",
  "Visszajelzések, belső jegyzetek és állapotkövetés",
  "Értékelési statisztikák helyszínenként és kártyánként",
  "E-mailes jelzés az 1–3 csillagos visszajelzésekről",
  "Saját Google-értékelési link és távoli kártyadeaktiválás",
];

function Pricing() {
  const monthly = PLAN_PRICING.monthly;
  const yearly = PLAN_PRICING.yearly;
  // 12 monthly payments versus one yearly payment, computed from the same
  // constants the billing page charges from -- never a hand-typed number.
  const yearlySaving = monthly.amountHuf * 12 - yearly.amountHuf;

  return (
    <section id="pricing" className="border-y border-[var(--pf-line)] bg-[var(--pf-surface)]">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <Eyebrow>Egyszerű, átlátható előfizetés</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Ugyanaz az irányítópult. Havi vagy éves díjjal.
        </h2>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-[var(--pf-ink-muted)]">
          14 napig ingyen kipróbálhatod, bankkártya megadása nélkül. Utána
          választhatsz havi vagy éves fizetést. A megújulást a számlázási
          felületen mondhatod le, az aktuális fizetett időszak végére.
        </p>

        <div className="mt-10 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-bg)] p-6">
              <p className="text-sm text-[var(--pf-ink-muted)]">{monthly.label} díj</p>
              <p
                className="mt-2 text-3xl font-medium"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {formatHuf(monthly.amountHuf)}
                <span className="text-base text-[var(--pf-ink-muted)]">
                  {" / "}
                  {monthly.cadence}
                </span>
              </p>
              <p className="mt-2 text-sm text-[var(--pf-ink-muted)]">
                Havi számlázás, automatikus megújulással.
              </p>
            </div>

            <div className="rounded-xl border border-[var(--pf-accent)]/40 bg-[var(--pf-bg)] p-6">
              <p className="text-sm text-[var(--pf-ink-muted)]">{yearly.label} díj</p>
              <p
                className="mt-2 text-3xl font-medium"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {formatHuf(yearly.amountHuf)}
                <span className="text-base text-[var(--pf-ink-muted)]">
                  {" / "}
                  {yearly.cadence}
                </span>
              </p>
              <p className="mt-2 text-sm text-[var(--pf-accent)]">
                Egy összegben évente. {formatHuf(yearlySaving)} megtakarítás
                12 havi díjhoz képest.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-bg)] p-6 sm:p-8">
            <h3 className="text-base font-medium">A vállalkozásod visszajelzéseihez</h3>
            <ul className="mt-4 flex flex-col gap-3">
              {PLAN_FEATURES.map((feature) => (
                <li key={feature} className="flex gap-3 text-sm leading-relaxed">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-[var(--pf-accent)]"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className={cn(
                "mt-7 inline-flex items-center gap-2 rounded-lg bg-[var(--pf-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]",
                FOCUS_RING,
              )}
            >
              Kipróbálom 14 napig
              <ArrowRight className="size-4" strokeWidth={2} />
            </Link>
            <p className="mt-3 text-xs text-[var(--pf-ink-muted)]">
              A feltüntetett árak bruttó előfizetési díjak. A fizikai NFC-kártya
              külön vásárolható meg. A próba alatt a létrehozott értékelőlinket
              kártya nélkül is használhatod. A Google-on közzétett értékelés
              külön lépés: az irányítópult a VéleményTapra beküldött visszajelzéseket mutatja.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Questions() {
  const questions = [
    { question: "Az NFC-kártya is benne van az előfizetésben?", answer: "Az előfizetés az irányítópult használatát tartalmazza. A fizikai kártyát külön vásárolhatod meg; az értékelőlinket kártya nélkül is kipróbálhatod." },
    { question: "Automatikusan megjelenik a vélemény a Google-on?", answer: "Nem. A VéleményTapra küldött visszajelzés a saját irányítópultodra kerül. A Google-értékelést a vendég külön, a Google felületén írja meg és teszi közzé. A Google-értékelések nem kerülnek automatikusan ebbe az irányítópultba." },
    { question: "Minden alacsony értékelésről külön e-mail érkezik?", answer: "Az 1–3 csillagos visszajelzések indíthatnak értesítést. A küldés kártyánként legfeljebb 5 percenként, vállalkozásonként legfeljebb 30 alkalommal történhet óránként. A sikeresen mentett véleményeket akkor is láthatod az irányítópulton, ha külön e-mail nem érkezik róluk." },
    { question: "Ki tudom kapcsolni a kártyámat?", answer: "Igen. Az NFC kártyák menüben deaktiválhatod, majd később újra aktiválhatod. A link és az előzmények megmaradnak. Az előfizetés lejárata önmagában nem kapcsolja ki a nyilvános értékelőoldalt." },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <Eyebrow>Mielőtt belevágsz</Eyebrow>
      <h2 className="mt-3 text-2xl font-medium sm:text-3xl" style={{ fontFamily: "var(--font-display)" }}>
        Rövid válaszok a fontos kérdésekre.
      </h2>
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {questions.map(({ question, answer }) => (
          <div key={question}>
            <h3 className="font-medium">{question}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--pf-ink-muted)]">{answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section
      className="text-center"
      // Round-5 R5-08: was --pf-accent-gradient (blue-to-cyan) -- computed
      // contrast for the white text sitting on top of it ranged as low as
      // ~1.5:1 near the cyan end, failing WCAG AA badly. This section is a
      // background FILL carrying text, not decorative gradient text, so
      // it needs the same accessible blue-to-teal formula, not just a
      // lighter touch -- see globals.css's --pf-accent-gradient-text.
      style={{ backgroundImage: "var(--pf-accent-gradient-text)" }}
    >
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <Nfc className="mx-auto size-8 text-white" strokeWidth={1.5} />
        <p className="mt-4 font-mono text-xs font-medium tracking-[0.14em] text-white uppercase">
          Kezdd a következő vendégeddel
        </p>
        <h2
          className="mt-3 text-3xl font-medium text-white sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Adj helyet a vendégeid véleményének.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-white/90 sm:text-base">
          Hozd létre a vállalkozásod fiókját, állítsd be az első helyszínt,
          és próbáld ki az értékelőlinkedet. 14 napig, bankkártya nélkül.
        </p>
        <Link
          href="/signup"
          className="mt-7 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-[var(--pf-accent)] transition-colors hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pf-accent)] focus-visible:outline-none"
        >
          Elindítom az ingyenes próbát
          <ArrowRight className="size-4" strokeWidth={2} />
        </Link>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 text-sm text-[var(--pf-ink-muted)] sm:flex-row sm:px-8">
      <span style={{ fontFamily: "var(--font-display)" }}>VéleményTap</span>
      <nav className="flex items-center gap-5">
        <Link href="/login" className={cn("rounded-md transition-colors hover:text-[var(--pf-ink)]", FOCUS_RING)}>
          Bejelentkezés
        </Link>
        <Link href="/signup" className={cn("rounded-md transition-colors hover:text-[var(--pf-ink)]", FOCUS_RING)}>
          Ingyenes próba
        </Link>
      </nav>
      <span>&copy; {new Date().getFullYear()} VéleményTap</span>
    </footer>
  );
}
