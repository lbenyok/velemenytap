import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { MembershipRole, OnboardingTourStatus } from "@/lib/supabase/database.types";

export type CurrentOrganization = {
  id: number;
  name: string;
  slug: string;
  role: MembershipRole;
  onboardingTourStatus: OnboardingTourStatus;
};

/**
 * Resolves the signed-in user's organization. A user can technically belong
 * to more than one (the schema supports it), but the dashboard doesn't have
 * an org switcher yet, so this always returns the earliest-joined one.
 */
export async function getCurrentOrganization(): Promise<CurrentOrganization | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("role, organizations(id, name, slug, onboarding_tour_status)")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // A transient database failure previously returned null here, which every
  // caller reads as "this user has no organization yet" -- silently
  // redirecting an existing owner to onboarding. Fail loudly instead so the
  // dashboard error boundary can offer a retry.
  if (error) {
    throw new Error("Nem sikerült betölteni a vállalkozásodat. Próbáld újra.");
  }

  if (!data?.organizations) {
    return null;
  }

  return {
    id: data.organizations.id,
    name: data.organizations.name,
    slug: data.organizations.slug,
    role: data.role,
    onboardingTourStatus: data.organizations.onboarding_tour_status,
  };
}
