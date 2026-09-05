import type { BillingStatus } from "@/lib/supabase/database.types";

export type OrganizationBilling = {
  status: BillingStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
};

/**
 * Whether the dashboard should be reachable. Two distinct ways in, cleanly
 * separated by whether a Stripe subscription exists yet:
 *   - No Stripe subscription: only this app's own no-card 14-day trial
 *     (organizations_after_insert_provision_trial, see the billing
 *     migration) can grant access, and only while trial_ends_at hasn't
 *     passed. Computed at call time rather than a stored "expired" status,
 *     so nothing needs a cron job to flip it -- see DECISIONS.md.
 *   - A Stripe subscription exists: its own status is authoritative and
 *     trial_ends_at is ignored entirely -- this covers both a normal paid
 *     subscription ('active') and a genuine Stripe-side trial
 *     ('trialing', e.g. a promo granted manually in the Stripe dashboard,
 *     distinct from this app's own pre-signup trial above). Checkout
 *     itself never requests a Stripe trial (see
 *     features/billing/actions.ts), so this path is rare in practice, but
 *     treating it as active is what Stripe's own status actually means.
 *
 * Deliberately does NOT gate anything but the dashboard itself -- the
 * public NFC landing page and feedback submission never check this. See
 * proxy.ts and app/dashboard/layout.tsx for where this is (and isn't)
 * enforced.
 */
export function isBillingActive(billing: OrganizationBilling | null): boolean {
  if (!billing) return false;

  if (billing.stripe_subscription_id) {
    return billing.status === "active" || billing.status === "trialing";
  }

  return billing.trial_ends_at !== null && new Date(billing.trial_ends_at) > new Date();
}
