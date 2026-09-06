"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import type { OnboardingTourStatus } from "@/lib/supabase/database.types";

/**
 * Persists the dashboard tour's state server-side, scoped to the
 * organization (see the migration's own comment for why organization, not
 * user). No new RPC needed: `onboarding_tour_status` is an ordinary
 * organization column with its own CHECK constraint enforcing exactly
 * "not_started" | "completed" | "skipped" at the database level regardless
 * of what this action sends -- it isn't one of the columns the
 * notification-email trigger protects, so the existing
 * `organizations_update` RLS policy (any member of the org) already covers
 * this write, the same as the plain `name`/`logo_url` fields on the
 * Settings page.
 *
 * Deliberately does nothing for "reopen" -- reopening the tour from the
 * header button is a client-only UI action that doesn't touch this stored
 * state at all, so a completed/skipped organization stays completed/
 * skipped (and therefore still won't auto-show the tour on the next normal
 * dashboard visit) even after someone reopens it once to look something
 * up again.
 */
export async function setOnboardingTourStatusAction(
  status: Extract<OnboardingTourStatus, "completed" | "skipped">,
): Promise<{ error?: string }> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({ onboarding_tour_status: status })
    .eq("id", organization.id);

  if (error) {
    return { error: "Nem sikerült menteni az útmutató állapotát." };
  }
  return {};
}
