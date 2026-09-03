"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type CreateOrganizationState = { error: string } | { error?: undefined };

const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "A szervezet nevének legalább 2 karakter hosszúnak kell lennie.")
    .max(100, "A szervezet neve legfeljebb 100 karakter lehet."),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks left behind by NFKD (á -> a, ő -> o, ...).
    .replace(/\p{Mark}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Creates an organization and its first (owner) membership.
 *
 * There is no RLS INSERT policy for organizations/organization_memberships
 * (see supabase/migrations/20260903150741_core_schema_and_rls.sql) — a
 * brand-new user isn't a member of any organization yet, so a normal
 * authenticated policy can't authorize this. Auth is checked explicitly
 * below, then the two inserts run through the admin (secret-key) client,
 * which bypasses RLS entirely.
 */
export async function createOrganizationAction(
  _prevState: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  const supabase = await createClient();
  const { data, error: claimsError } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;

  if (claimsError || !userId) {
    redirect("/login");
  }

  const parsed = createOrganizationSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const baseSlug = slugify(parsed.data.name) || "organization";
  const admin = createAdminClient();

  let organizationId: number | null = null;
  let slug = baseSlug;

  // Retry with a random suffix on a slug collision, instead of building a
  // full slug-negotiation UI for MVP.
  for (let attempt = 0; attempt < 5 && organizationId === null; attempt++) {
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .insert({ name: parsed.data.name, slug })
      .select("id")
      .single();

    if (org) {
      organizationId = org.id;
      break;
    }

    if (orgError?.code === "23505") {
      slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      continue;
    }

    return { error: "Nem sikerült létrehozni a szervezetet. Kérjük, próbáld újra." };
  }

  if (organizationId === null) {
    return { error: "Nem sikerült létrehozni a szervezetet. Kérjük, próbáld újra." };
  }

  const { error: membershipError } = await admin
    .from("organization_memberships")
    .insert({ organization_id: organizationId, user_id: userId, role: "owner" });

  if (membershipError) {
    // Don't leave an ownerless, inaccessible organization behind.
    await admin.from("organizations").delete().eq("id", organizationId);
    return {
      error: "Nem sikerült befejezni a szervezet beállítását. Kérjük, próbáld újra.",
    };
  }

  redirect("/dashboard");
}
