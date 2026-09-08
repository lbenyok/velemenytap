import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { OrganizationBilling } from "./status";

/**
 * Found during an independent review: this used to destructure only
 * `{ data }`, silently discarding `error` -- a transient database failure
 * (network blip, RLS misconfiguration, timeout) returned `null` here
 * indistinguishable from "this organization genuinely has no billing
 * row." Every caller (the dashboard paywall, the billing page,
 * signInAction, createCheckoutSessionAction's already-subscribed guard)
 * treats `null` as "not active" -- so a transient error could silently
 * lock a paying customer out of their own dashboard, or worse, let
 * createCheckoutSessionAction's guard treat an org that actually already
 * has a live subscription as if it had none, opening the door to a
 * duplicate one. Authorization and billing-state checks must fail
 * closed on a genuine error, not fail open into "must be nothing here."
 * Now throws on a real database error instead -- callers that need a
 * softer fallback (signInAction's own single-hop redirect optimization,
 * not a security boundary -- see that function's own comment) catch it
 * explicitly at the call site rather than this function silently
 * absorbing it into a value indistinguishable from "no subscription."
 */
export async function getOrganizationBilling(
  organizationId: number,
): Promise<OrganizationBilling | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_billing")
    .select(
      "status, trial_ends_at, current_period_end, cancel_at_period_end, stripe_subscription_id, grandfathered_at, activated_at",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read organization_billing for organization ${organizationId}: ${error.message}`);
  }

  return data;
}
