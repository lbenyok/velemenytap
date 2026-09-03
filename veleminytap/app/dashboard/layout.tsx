import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { signOutAction } from "@/features/auth/actions";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between border-b px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            VéleményTap
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/dashboard" className="hover:text-foreground">
              Overview
            </Link>
            <Link href="/dashboard/locations" className="hover:text-foreground">
              Locations
            </Link>
            <Link href="/dashboard/nfc-cards" className="hover:text-foreground">
              NFC Cards
            </Link>
            <Link href="/dashboard/feedback" className="hover:text-foreground">
              Feedback
            </Link>
            <Link href="/dashboard/analytics" className="hover:text-foreground">
              Analytics
            </Link>
            <Link href="/dashboard/settings" className="hover:text-foreground">
              Settings
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{organization.name}</span>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
