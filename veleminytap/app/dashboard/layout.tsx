import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Fraunces } from "next/font/google";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive } from "@/features/billing/status";
import { signOutAction } from "@/features/auth/actions";
import { Button } from "@/components/ui/button";
import { DashboardNav } from "./dashboard-nav";
import { TourProvider } from "@/features/onboarding-tour/tour-provider";
import { ReopenTourButton } from "@/features/onboarding-tour/reopen-tour-button";

// Same display face as the public marketing/feedback pages (app/page.tsx),
// used just as restrainedly here: the wordmark and page titles only.
// Everything else -- tables, forms, buttons -- stays in the body sans-serif,
// so the dashboard reads as "same brand" rather than "trying to look like
// the homepage."
const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600"],
  variable: "--font-display",
});

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims.sub) {
    redirect("/login");
  }

  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  // Paywall. Protect-by-default, same philosophy as proxy.ts's auth gate:
  // every dashboard route requires an active subscription (or an
  // unexpired trial) except the billing page itself -- a newly added
  // dashboard page is covered automatically, nobody has to remember to
  // opt in. Never gates the public NFC/feedback pages (proxy.ts doesn't
  // touch this at all) -- a card already sold and sitting on a customer's
  // counter keeps collecting real feedback regardless of billing status.
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (pathname !== "/dashboard/billing") {
    const billing = await getOrganizationBilling(organization.id);
    if (!isBillingActive(billing)) {
      redirect("/dashboard/billing");
    }
  }

  return (
    <TourProvider initialStatus={organization.onboardingTourStatus}>
      <div className={`flex min-h-svh flex-col ${fraunces.variable}`}>
        {/* Round-4 R4-06 (breakpoint corrected in round-5 R5-07): this row
            used to hold the wordmark, all six nav links, the org name, and
            the logout button at once -- reliably overflowing below ~768px,
            then found to still visually overlap the org name up through
            1024px. DashboardNav collapses its own six links into a menu
            button below `xl` (see its own comment); the pieces that stay
            in this row at every width are the wordmark, the tour's reopen
            button (icon-only precisely so it doesn't reopen that fight),
            and a reachable sign-out control. */}
        <header className="flex h-14 items-center justify-between gap-2 border-b px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-6">
            <Link
              href="/dashboard"
              className="shrink-0 text-base font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Vélemény
              {/* Round-4 R4-07: the homepage's own gradient ends at a cyan
                  (#22d3ee) whose contrast against white is only ~1.8:1 --
                  fine for a large decorative hero flourish, not for small,
                  persistent, load-bearing navigational text. --brand-gradient-text
                  swaps that endpoint for a deeper teal that keeps the same
                  two-hue brand identity at >= 4.5:1 in light mode; dark
                  mode's existing gradient already has sufficient contrast
                  against the dark surface and is reused unchanged. */}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: "var(--brand-gradient-text)" }}
              >
                Tap
              </span>
            </Link>
            <DashboardNav />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            <span className="hidden max-w-40 truncate text-sm text-muted-foreground md:inline">
              {organization.name}
            </span>
            <ReopenTourButton />
            <form action={signOutAction}>
              {/* Icon-only below sm to guarantee the row fits at 320px --
                  "Kijelentkezés" is reachable via its accessible name
                  either way, just not always shown as visible text. */}
              <Button type="submit" variant="ghost" size="icon-sm" className="sm:hidden" aria-label="Kijelentkezés">
                <LogOut className="size-4" aria-hidden="true" />
              </Button>
              <Button type="submit" variant="ghost" size="sm" className="hidden sm:inline-flex">
                Kijelentkezés
              </Button>
            </form>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6">{children}</main>
      </div>
    </TourProvider>
  );
}
