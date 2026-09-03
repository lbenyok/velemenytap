import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/auth-shell";
import { CreateOrganizationForm } from "@/features/organizations/create-organization-form";

export const metadata: Metadata = { title: "Set up your business — VéleményTap" };

export default async function OnboardingPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims.sub) {
    redirect("/login");
  }

  const { count } = await supabase
    .from("organization_memberships")
    .select("id", { count: "exact", head: true });

  if (count && count > 0) {
    redirect("/dashboard");
  }

  return (
    <AuthShell
      title="Set up your business"
      description="Create your organization to start collecting feedback."
    >
      <CreateOrganizationForm />
    </AuthShell>
  );
}
