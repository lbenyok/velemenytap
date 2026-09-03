import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/auth-shell";
import { CreateOrganizationForm } from "@/features/organizations/create-organization-form";

export const metadata: Metadata = { title: "Állítsd be a vállalkozásod — VéleményTap" };

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
      title="Állítsd be a vállalkozásod"
      description="Hozd létre a szervezetedet, hogy elkezdhesd gyűjteni a véleményeket."
    >
      <CreateOrganizationForm />
    </AuthShell>
  );
}
