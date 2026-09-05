import Link from "next/link";
import type { ReactNode } from "react";
import { Fraunces } from "next/font/google";
import { cn } from "@/lib/utils";

// Same brand palette and display face as the public marketing/feedback
// pages (app/page.tsx, app/globals.css's .public-feedback block) -- the
// auth flow is a customer's first real impression of the product, so it
// should read as the same brand from the very first screen, not a
// generic dashboard-styled form.
const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "public-feedback flex min-h-svh flex-col items-center justify-center gap-8 bg-[var(--pf-bg)] p-6 text-[var(--pf-ink)]",
        fraunces.variable,
      )}
    >
      <Link
        href="/"
        className="text-2xl font-semibold tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Vélemény
        <span
          className="bg-clip-text text-transparent"
          style={{ backgroundImage: "var(--pf-accent-gradient)" }}
        >
          Tap
        </span>
      </Link>
      <div className="w-full max-w-sm rounded-2xl border border-[var(--pf-line)] bg-[var(--pf-surface)] p-6 shadow-sm sm:p-8">
        <div className="mb-6 space-y-1 text-center">
          <h1
            className="text-xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {title}
          </h1>
          <p className="text-sm text-[var(--pf-ink-muted)]">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
