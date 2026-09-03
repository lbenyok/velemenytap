import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { Star, Nfc, Mail, Inbox, BarChart3, ArrowRight, Check } from "lucide-react";
import { RatingDemo } from "@/features/marketing/rating-demo";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "VéleményTap — NFC visszajelzés, ami sosem rejt el egy rossz értékelést",
  description:
    "Helyezz ki egy NFC-kártyát a pultra. A vásárlók öt másodperc alatt értékelik a látogatást, és ugyanazt a Google-értékelési linket kapják — válogatás nélkül.",
};

const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const VERTICALS = [
  "Kávézók és éttermek",
  "Szalonok és wellness",
  "Rendelők és klinikák",
  "Edzőtermek és stúdiók",
  "Üzletek",
  "Szolgáltató vállalkozások",
];

const STEPS = [
  {
    n: "01",
    title: "Koppintás",
    body: "A vásárló a telefonjával megérinti a kártyát. Nincs alkalmazás, nincs bejelentkezés, nem kell URL-t beírni.",
  },
  {
    n: "02",
    title: "Értékelés",
    body: "1-től 5 csillagig értékel, és írhat hozzá megjegyzést is, ha szeretne. Mindössze öt másodperc.",
  },
  {
    n: "03",
    title: "Te mindent látsz",
    body: "Azonnal megjelenik az irányítópultodon. Alacsony értékelésnél e-mail is érkezik a csapatodnak, még ugyanabban a percben.",
  },
];

const DASHBOARD_CARDS = [
  {
    icon: Inbox,
    title: "Vélemény-postaláda",
    body: "Minden értékelés egy helyen, szűrhető helyszín, kártya vagy státusz szerint. Semmi sem vész el egy fiókban, amit elfelejtesz megnézni.",
  },
  {
    icon: Mail,
    title: "Azonnali jelzés a rosszakról",
    body: "Egy 1 vagy 2 csillagos értékelés azonnal e-mailt küld a csapatodnak — mielőtt nyilvános véleménnyé válna.",
  },
  {
    icon: BarChart3,
    title: "Trendek időben",
    body: "Átlagos értékelés, mennyiség, és hogy melyik helyszín vagy kártya teljesít gyengén — nem csak a mai szám.",
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
          style={{ backgroundImage: "var(--pf-accent-gradient)" }}
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
          <Eyebrow>NFC visszajelzés üzleteknek</Eyebrow>
          <h1
            className="mt-4 text-4xl leading-[1.08] font-medium text-balance sm:text-5xl lg:text-[3.4rem]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Koppints a kártyára.
            <br />
            Halld az{" "}
            <span
              className="bg-clip-text text-transparent italic"
              style={{ backgroundImage: "var(--pf-accent-gradient)" }}
            >
              igazat.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-[var(--pf-ink-muted)] sm:text-lg">
            Egy NFC-kártya a pultnál öt másodperc alatt valódi értékeléssé
            alakít minden látogatást. Minden vásárló ugyanazt a
            Google-értékelési linket kapja — akár 1, akár 5 csillagot adott.
            A vélemények szelektálása sérti a Google szabályzatát. Mi nem
            válogatunk.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-[var(--pf-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-accent-hover)]",
                FOCUS_RING,
              )}
            >
              Ingyenes regisztráció
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
        <Eyebrow>Nincs válogatás</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Minden értékelés ugyanoda vezet.
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
          Minden helyre, ahova betérnek az emberek.
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
        Egy felület minden koppintáshoz.
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

function FinalCta() {
  return (
    <section
      className="text-center"
      style={{ backgroundImage: "var(--pf-accent-gradient)" }}
    >
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <Nfc className="mx-auto size-8 text-white" strokeWidth={1.5} />
        <h2
          className="mt-5 text-3xl font-medium text-white sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Tedd ki az első kártyát a pultra.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-white/80 sm:text-base">
          Ingyenesen indulhatsz. Nincs szükség bankkártyára, nincs szerződés.
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
