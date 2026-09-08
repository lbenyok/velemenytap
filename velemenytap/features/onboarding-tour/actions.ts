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
 *
 * Found during an independent review: the UPDATE's own zero-affected-rows
 * result is ambiguous by itself -- it's produced both by the guard's
 * intended no-op (already "completed") and by a real failure (membership
 * revoked between the lookup above and this call, so RLS no longer permits
 * the write; or the organization is simply gone). The two were previously
 * treated identically as success, which meant a real failure could report
 * success and the client would close the tour having persisted nothing.
 * Disambiguated below with a follow-up read through this same client.
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
  const { data, error } = await supabase
    .from("organizations")
    .update({ onboarding_tour_status: status })
    .eq("id", organization.id)
    .neq("onboarding_tour_status", "completed")
    .select("onboarding_tour_status");

  if (error) {
    return { error: "Nem sikerült menteni az útmutató állapotát." };
  }
  if (data.length > 0) {
    // The WHERE clause matched and RLS's own WITH CHECK allowed the write --
    // genuinely, freshly persisted by this call.
    return {};
  }

  // Zero rows affected is ambiguous on its own. It's what the WHERE
  // clause's own guard produces when the organization already reads
  // "completed" (the common, harmless no-op this guard exists for) -- but
  // it's equally what a membership revoked between the lookup above and
  // this UPDATE would produce (RLS's `is_org_member` check no longer
  // passes, so the row simply doesn't match for this session anymore), or
  // a deleted organization. Those are real failures: the write did not
  // happen, but the caller would otherwise be told it succeeded and the
  // client would close the tour having persisted nothing. An affected-row
  // count alone can't distinguish these, so read the row back through this
  // same RLS-bound client and decide from its actual value.
  const { data: current, error: readError } = await supabase
    .from("organizations")
    .select("onboarding_tour_status")
    .eq("id", organization.id)
    .maybeSingle();

  if (readError || !current) {
    // Unreadable or gone under this session's own RLS view -- membership
    // no longer holds, or the organization no longer exists. Not the
    // harmless no-op case; report it as a real failure.
    return { error: "Nem sikerült menteni az útmutató állapotát." };
  }
  if (current.onboarding_tour_status !== "completed") {
    // Readable, and not "completed" -- the WHERE clause should have let
    // this UPDATE through, so zero rows here means something genuinely
    // prevented the write (RLS's WITH CHECK, most likely) rather than the
    // terminal-state guard doing its job. Report it rather than treating
    // an unexplained no-op as success.
    return { error: "Nem sikerült menteni az útmutató állapotát." };
  }
  // Confirmed directly: the organization already reads "completed". The
  // guard blocked a write that would have been a no-op anyway.
  return {};
}
