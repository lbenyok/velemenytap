import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { Star, Nfc, Mail, Inbox, BarChart3, ArrowRight, Check } from "lucide-react";
import { RatingDemo } from "@/features/marketing/rating-demo";
import { cn } from "@/lib/utils";
import { PLAN_PRICING } from "@/features/billing/plans";

export const metadata: Metadata = {
  title: "VéleményTap — minden csillag számít",
  description:
    "NFC-kártyát teszel ki a pultra. A vásárlóid pár másodperc alatt értékelnek, és utána mindenki ugyanazt a Google-értékelési linket kapja, a csillagok számától függetlenül.",
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
    title: "Koppintás",
    body: "A vásárló odaérinti a telefonját a kártyához. Nincs mit letölteni, nincs bejelentkezés, nem kell semmit beírnia.",
  },
  {
    n: "02",
    title: "Értékelés",
    body: "Egytől öt csillagig értékel, és ha akar, írhat is pár szót hozzá. Ennyi az egész, öt másodperc alatt.",
  },
  {
    n: "03",
    title: "Te mindent látsz",
    body: "Azonnal megjelenik az irányítópultodon. Alacsony értékelésnél e-mailes értesítést is beállíthatsz, hogy időben léphess.",
  },
];

const DASHBOARD_CARDS = [
  {
    icon: Inbox,
    title: "Vélemény-postaláda",
    body: "Az összes értékelés egy helyen van, szűrhetsz helyszín, kártya vagy státusz szerint. Semmi nem vész el egy olyan postafiókban, amit elfelejtesz megnézni.",
  },
  {
    icon: Mail,
    title: "Értesítés a rossz értékelésekről",
    body: "Az egy- és kétcsillagos véleményekhez e-mailes értesítést is beállíthatsz, hogy időben reagálhass.",
  },
  {
    icon: BarChart3,
    title: "Trendek időben",
    body: "Látod az átlagot, a mennyiséget, és hogy melyik helyszín vagy kártya marad el a többitől. Nem csak a mai napot, a trendet is.",
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
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}

function SiteNav() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
      <span
        className="text-lg font-semibold tracking-tight"
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
          Regisztráció
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
          <Eyebrow>Visszajelzésből jobb kiszolgálás</Eyebrow>
          <h1
            className="mt-4 text-4xl leading-[1.08] font-medium text-balance sm:text-5xl lg:text-[3.4rem]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Tudd meg, mit élnek át
            <br />
            <span
              className="bg-clip-text text-transparent italic"
              style={{ backgroundImage: "var(--pf-accent-gradient-text)" }}
            >
              a vendégeid.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-[var(--pf-ink-muted)] sm:text-lg">
            Egy érintés a kártyán, néhány szó a tapasztalatról. Te egy helyen
            követheted a visszajelzéseket, és láthatod, hol érdemes javítani.
            A vendégeid ezután külön, önkéntes Google-értékelést is írhatnak,
            a csillagok számától függetlenül.
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
              Nézd meg, hogyan működik
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
        <Eyebrow>Minden vélemény számít</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          A Google-értékelés lehetősége minden vendégnek jár.
        </h2>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <div
              key={n}
              className="flex flex-col items-center gap-3 rounded-xl border border-[var(--pf-line)] bg-[var(--pf-bg)] px-3 py-5 text-center"
            >
              <div className="flex gap-0.5" aria-hidden="true">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star
                    key={i}
                    className={cn(
                      "size-3.5",
                      i < n
                        ? "fill-[var(--pf-accent-2)] text-[var(--pf-accent-2)]"
                        : "fill-none text-[var(--pf-line)]",
                    )}
                    strokeWidth={1.5}
                  />
                ))}
              </div>
              <span className="text-xs text-[var(--pf-ink-muted)]">
                {n} csillag
              </span>
              <div className="flex items-center gap-1 rounded-full bg-[var(--pf-accent)]/10 px-2.5 py-1 text-[0.7rem] font-medium text-[var(--pf-accent)]">
                <Check className="size-3" strokeWidth={2.5} />
                Ugyanaz a link
              </div>
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
        Három lépés, alkalmazás nélkül.
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
        <Eyebrow>A pultodhoz tervezve</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Bárhol, ahol ügyfelek betérnek.
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
      <Eyebrow>Mit kapsz</Eyebrow>
      <h2
        className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Minden visszajelzés egyetlen irányítópulton.
      </h2>
      <div className="mt-10 grid gap-5 sm:grid-cols-3">
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
  "Korlátlan helyszín és NFC-kártya",
  "Korlátlan vélemény, szűrhető postaláda",
  "E-mailes értesítés a negatív értékelésekről",
  "Google-értékelési link minden vendégnek, csillagszámtól függetlenül",
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
        <Eyebrow>Árazás</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Egy csomag, minden benne van.
        </h2>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-[var(--pf-ink-muted)]">
          14 napig ingyen kipróbálhatod, bankkártya megadása nélkül. Utána
          választhatsz havi vagy éves fizetést, és bármikor lemondhatod.
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
                Havonta fizetsz, bármikor lemondhatod.
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
                Évente {formatHuf(yearlySaving)} megtakarítás.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-bg)] p-6 sm:p-8">
            <h3 className="text-base font-medium">Mindkét fizetési módban</h3>
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
              A feltüntetett árak bruttó árak. Az NFC-kártyát külön rendeled
              meg, a szolgáltatás fizikai kártya nélkül, sima linkkel is
              működik.
            </p>
          </div>
        </div>
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
          Minden csillag számít
        </p>
        <h2
          className="mt-3 text-3xl font-medium text-white sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Tedd ki az első kártyát a pultra.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-white/90 sm:text-base">
          Ingyen kipróbálhatod, bankkártya és aláírás nélkül.
        </p>
        <Link
          href="/signup"
          className="mt-7 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-[var(--pf-accent)] transition-colors hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pf-accent)] focus-visible:outline-none"
        >
          Fiók létrehozása
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
          Regisztráció
        </Link>
      </nav>
      <span>&copy; {new Date().getFullYear()} VéleményTap</span>
    </footer>
  );
}
