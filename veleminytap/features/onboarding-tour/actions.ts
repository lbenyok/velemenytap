"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type SetOnboardingTourStatusResult = { error?: string };

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
 * Found during an independent review: TypeScript's parameter type is
 * erased at runtime -- a Server Action is reachable via a raw POST to its
 * action id, not just through this module's own typed call sites, so a
 * forged request could send any string here. Validated explicitly below,
 * not just trusted to the type system.
 *
 * State transitions are monotonic and enforced ATOMICALLY in the UPDATE's
 * own WHERE clause, not via a separate read-then-write (which would leave
 * a window for a concurrent request, including one from a different
 * device/tab, to land in between):
 *   not_started -> skipped     allowed
 *   not_started -> completed   allowed
 *   skipped     -> completed   allowed (finishing a reopened, previously-
 *                               skipped tour)
 *   skipped     -> skipped     harmless no-op
 *   completed   -> anything    never -- `completed` is terminal. A
 *                               manually reopened, already-completed tour
 *                               being dismissed again (Escape, Kihagyom)
 *                               must never downgrade it back to "skipped".
 * The `<> 'completed'` guard below is what actually enforces this against
 * the database's own current value at the moment the statement runs, not
 * against whatever the calling client believes the value to be -- correct
 * even if the client's own belief is stale (e.g. a different device
 * completed the tour since this client last read the organization).
 *
 * Deliberately does nothing for "reopen" itself -- reopening the tour from
 * the header button is a client-only UI action that doesn't call this
 * action at all. Only a subsequent dismissal or completion does.
 */
export async function setOnboardingTourStatusAction(
  status: string,
): Promise<SetOnboardingTourStatusResult> {
  if (status !== "completed" && status !== "skipped") {
    return { error: "Érvénytelen állapot." };
  }

  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({ onboarding_tour_status: status })
    .eq("id", organization.id)
    .neq("onboarding_tour_status", "completed")
    .select("onboarding_tour_status");

  if (error) {
    return { error: "Nem sikerült menteni az útmutató állapotát." };
  }
  // Zero rows affected means the WHERE clause's own guard blocked the
  // write -- the organization's status was already "completed" (either
  // already known to this client, or updated concurrently by another
  // device/tab since). That's the guard working as intended, not a
  // failure: the caller asked to record something, and the organization's
  // terminal state is correctly unchanged. Only a genuine database error
  // above is reported as a failure to the caller.
  return {};
}
