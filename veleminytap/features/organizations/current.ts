import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { MembershipRole } from "@/lib/supabase/database.types";

export type CurrentOrganization = {
  id: number;
  name: string;
  slug: string;
  role: MembershipRole;
};

/**
 * Resolves the signed-in user's organization. A user can technically belong
 * to more than one (the schema supports it), but the dashboard doesn't have
 * an org switcher yet, so this always returns the earliest-joined one.
 */
export async function getCurrentOrganization(): Promise<CurrentOrganization | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("organization_memberships")
    .select("role, organizations(id, name, slug)")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data?.organizations) {
    return null;
  }

  return {
    id: data.organizations.id,
    name: data.organizations.name,
    slug: data.organizations.slug,
    role: data.role,
  };
}
