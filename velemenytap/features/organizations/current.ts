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

  // Round-14 R14-04. This query used to have no user filter at all, and read
  // "the earliest membership row I can SEE" as "my membership". Those are not
  // the same set: `organization_memberships_select`'s USING clause is
  // `private.is_org_member(organization_id)`, so every member can read the
  // whole roster -- by design, and the dashboard needs it. Ordering that
  // roster by `created_at` and taking the first row therefore returns the
  // OWNER's row to a staff member, and `role` came back as `owner`.
  //
  // `canManageBilling(organization.role)` is fed directly from this value, so
  // the one role check in the application was reading a role that need not
  // belong to the caller. Not reachable today -- the only membership-creating
  // path writes `owner` and there is no invite flow -- but a read that is
  // wrong for a reason unrelated to why it is unreachable.
  //
  // getClaims() verifies the JWT signature rather than trusting a decoded
  // body, and `sub` is the authenticated user id.
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("role, organizations(id, name, slug, onboarding_tour_status)")
    .eq("user_id", userId)
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
