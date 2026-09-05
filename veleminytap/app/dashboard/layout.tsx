import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Fraunces } from "next/font/google";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive } from "@/features/billing/status";
import { signOutAction } from "@/features/auth/actions";
import { Button } from "@/components/ui/button";
import { DashboardNav } from "./dashboard-nav";

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
    <div className={`flex min-h-svh flex-col ${fraunces.variable}`}>
      <header className="flex h-14 items-center justify-between gap-4 border-b px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/dashboard"
            className="shrink-0 text-base font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Vélemény
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "var(--brand-gradient)" }}
            >
              Tap
            </span>
          </Link>
          <DashboardNav />
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {organization.name}
          </span>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Kijelentkezés
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
