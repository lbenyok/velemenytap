import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { Star, Nfc, Mail, Inbox, BarChart3, ArrowRight, Check } from "lucide-react";
import { RatingDemo } from "@/features/marketing/rating-demo";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "VéleményTap — NFC feedback that never hides a bad rating",
  description:
    "Put an NFC card at the counter. Customers rate their visit in five seconds and get the same Google review link either way — no gating, ever.",
};

const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-wine)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pf-bg)]";

const VERTICALS = [
  "Cafés & restaurants",
  "Salons & spas",
  "Clinics & practices",
  "Gyms & studios",
  "Retail shops",
  "Service businesses",
];

const STEPS = [
  {
    n: "01",
    title: "Tap",
    body: "A customer taps the card with their phone. No app, no login, no typing a URL.",
  },
  {
    n: "02",
    title: "Rate",
    body: "They pick 1 to 5 stars and can add a note if they want. Takes about five seconds.",
  },
  {
    n: "03",
    title: "You see everything",
    body: "It lands in your dashboard instantly. A low rating emails your team the same minute.",
  },
];

const DASHBOARD_CARDS = [
  {
    icon: Inbox,
    title: "Feedback inbox",
    body: "Every rating, filterable by location, card, or status. Nothing sits somewhere you forget to check.",
  },
  {
    icon: Mail,
    title: "Alerts on the bad ones",
    body: "A 1 or 2-star rating emails your team the moment it lands — before it becomes a public review.",
  },
  {
    icon: BarChart3,
    title: "Trends over time",
    body: "Average rating, volume, and which location or card is struggling — not just today's number.",
  },
];

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
        VéleményTap
      </span>
      <nav className="flex items-center gap-3 sm:gap-5">
        <Link
          href="/login"
          className={cn(
            "rounded-md text-sm text-[var(--pf-ink-muted)] transition-colors hover:text-[var(--pf-ink)]",
            FOCUS_RING,
          )}
        >
          Log in
        </Link>
        <Link
          href="/signup"
          className={cn(
            "rounded-lg bg-[var(--pf-wine)] px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-wine-hover)]",
            FOCUS_RING,
          )}
        >
          Get started
        </Link>
      </nav>
    </header>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-xs font-medium tracking-[0.14em] text-[var(--pf-wine)] uppercase">
      {children}
    </p>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-5 pt-8 pb-20 sm:px-8 sm:pt-14 sm:pb-28">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700">
          <Eyebrow>NFC feedback for real places</Eyebrow>
          <h1
            className="mt-4 text-4xl leading-[1.08] font-medium text-balance sm:text-5xl lg:text-[3.4rem]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Tap the card.
            <br />
            Hear the{" "}
            <span className="text-[var(--pf-wine)] italic">truth.</span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-[var(--pf-ink-muted)] sm:text-lg">
            An NFC card by the register turns any visit into a rating in
            under five seconds. Every customer gets the same Google review
            link — a 1-star visit and a 5-star visit end up in the exact same
            place. Gating reviews breaks Google&apos;s rules. We just don&apos;t do
            it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-[var(--pf-wine)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--pf-wine-hover)]",
                FOCUS_RING,
              )}
            >
              Get started free
              <ArrowRight className="size-4" strokeWidth={2} />
            </Link>
            <a
              href="#how-it-works"
              className={cn(
                "rounded-md text-sm font-medium text-[var(--pf-ink)] underline decoration-[var(--pf-line)] decoration-2 underline-offset-4 transition-colors hover:decoration-[var(--pf-wine)]",
                FOCUS_RING,
              )}
            >
              See how it works
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
        <Eyebrow>No cherry-picking</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Every rating ends the same way.
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
                        ? "fill-[var(--pf-gold)] text-[var(--pf-gold)]"
                        : "fill-none text-[var(--pf-line)]",
                    )}
                    strokeWidth={1.5}
                  />
                ))}
              </div>
              <span className="text-xs text-[var(--pf-ink-muted)]">
                {n} star{n === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-1 rounded-full bg-[var(--pf-wine)]/10 px-2.5 py-1 text-[0.7rem] font-medium text-[var(--pf-wine)]">
                <Check className="size-3" strokeWidth={2.5} />
                Same link
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
      <Eyebrow>How it works</Eyebrow>
      <h2
        className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Three steps, no app required.
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
        <Eyebrow>Built for your counter</Eyebrow>
        <h2
          className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Any place people walk into.
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
      <Eyebrow>What you get</Eyebrow>
      <h2
        className="mt-3 max-w-xl text-2xl font-medium sm:text-3xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        One inbox for every tap.
      </h2>
      <div className="mt-10 grid gap-5 sm:grid-cols-3">
        {DASHBOARD_CARDS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6"
          >
            <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--pf-wine)]/10 text-[var(--pf-wine)]">
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
    <section className="bg-[var(--pf-wine)]">
      <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:px-8 sm:py-20">
        <Nfc className="mx-auto size-8 text-[var(--pf-gold)]" strokeWidth={1.5} />
        <h2
          className="mt-5 text-3xl font-medium text-white sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Put the first card on your counter.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-white/70 sm:text-base">
          Free to start. No credit card, no contract.
        </p>
        <Link
          href="/signup"
          className="mt-7 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-[var(--pf-wine)] transition-colors hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pf-wine)] focus-visible:outline-none"
        >
          Create your account
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
          Log in
        </Link>
        <Link href="/signup" className={cn("rounded-md transition-colors hover:text-[var(--pf-ink)]", FOCUS_RING)}>
          Sign up
        </Link>
      </nav>
      <span>&copy; {new Date().getFullYear()} VéleményTap</span>
    </footer>
  );
}
