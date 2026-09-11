"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type CreateOrganizationState = { error: string } | { error?: undefined };

const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "A szervezet nevének legalább 2 karakter hosszúnak kell lennie.")
    .max(100, "A szervezet neve legfeljebb 100 karakter lehet."),
});

/**
 * Creates an organization and its first (owner) membership by calling
 * create_organization_atomic (see its migration), a single atomic,
 * idempotent database function -- not two separate inserts from here. A
 * double-submit (double-click, network retry, navigating back to
 * /onboarding and resubmitting) returns the user's existing organization
 * instead of creating a second one; a failure partway through rolls back
 * the whole thing instead of leaving an ownerless organization behind.
 */
export async function createOrganizationAction(
  _prevState: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  const supabase = await createClient();
  const { data, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !data?.claims.sub) {
    redirect("/login");
  }

  const parsed = createOrganizationSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const { error } = await supabase
    .rpc("create_organization_atomic", { p_name: parsed.data.name })
    .single();

  if (error) {
    return { error: "Nem sikerült létrehozni a szervezetet. Kérjük, próbáld újra." };
  }

  redirect("/dashboard");
}
