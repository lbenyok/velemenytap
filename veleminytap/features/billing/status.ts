import type { BillingStatus, MembershipRole } from "@/lib/supabase/database.types";

/**
 * Found during an independent review: createCheckoutSessionAction and
 * createPortalSessionAction previously authorized on organization
 * membership alone -- any role at all, including `manager`/`staff` --
 * ignoring the role `getCurrentOrganization()` already returns. Billing is
 * a financial/administrative action (creating a real recurring charge,
 * or opening a portal that can cancel one); restricted to the two roles
 * this product's role model treats as administrative, matching how most
 * SaaS products scope billing access. Only `owner` memberships are
 * actually created today (there is no invite flow yet), so this has no
 * visible effect until one exists -- enforced now anyway, so a future
 * invite flow doesn't have to remember to add this check retroactively.
 */
export function canManageBilling(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export type OrganizationBilling = {
  status: BillingStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
  grandfathered_at: string | null;
  activated_at: string | null;
};

/**
 * Stripe subscription statuses that represent a live or recoverable
 * subscription -- one that a second, concurrent Checkout Session would
 * risk double-charging the organization for. `canceled` and
 * `incomplete_expired` are deliberately excluded: both are terminal,
 * dead ends that Checkout's own guard (features/billing/actions.ts) must
 * let an organization start a fresh subscription past, not be
 * permanently blocked by. See DECISIONS.md for the full transition table
 * this set and isBillingActive below were both derived from.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<BillingStatus> = new Set([
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "unpaid",
  "paused",
]);

export function hasLiveSubscription(billing: Pick<OrganizationBilling, "status" | "stripe_subscription_id"> | null): boolean {
  if (!billing?.stripe_subscription_id) return false;
  return LIVE_SUBSCRIPTION_STATUSES.has(billing.status);
}

/**
 * Whether the dashboard should be reachable. The explicit state machine,
 * found to be incomplete during an independent review (the previous
 * version switched to Stripe's status the instant ANY subscription
 * existed, even one that had never successfully activated -- see
 * DECISIONS.md and the activated_at migration's own comment for the full
 * incident), checked in this order:
 *
 *   1. A real Stripe subscription (`stripe_subscription_id` set) whose
 *      `status` is `'active'` or `'trialing'`: always allowed. A
 *      genuinely good current Stripe status is the strongest, most direct
 *      signal there is, and is authoritative on its own -- checked first,
 *      independent of anything else on the row. Gated on
 *      `stripe_subscription_id` specifically because `status` defaults to
 *      `'trialing'` at the database level even for a row that has never
 *      had a real Stripe subscription at all (the column's own default,
 *      shared with the no-card signup trial's row shape) -- without this
 *      guard, every fresh signup would read as "Stripe-trialing" and
 *      bypass its own `trial_ends_at` expiry entirely.
 *   2. Otherwise, `activated_at` set (a real payment has genuinely
 *      succeeded for this organization at least once, ever, even if the
 *      subscription has since lapsed): blocked. Grandfathering/the
 *      no-card trial are a one-time bridge to get an organization to its
 *      first real activation, not something to fall back to once real
 *      billing has genuinely started -- a canceled or past-due paying
 *      customer does not regain access by virtue of having been
 *      grandfathered a year ago, or of a trial that expired long before
 *      it ever subscribed.
 *   3. Otherwise (status isn't active/trialing, and billing has never
 *      actually activated -- whether because no subscription exists at
 *      all, or one does but never got past incomplete/incomplete_expired/
 *      canceled-before-ever-paying): access comes from whichever
 *      pre-payment grant applies --
 *       - grandfathered_at set: always active, no expiry (see
 *         DECISIONS.md's grandfathering entry). This is what keeps a
 *         grandfathered organization's access intact through a failed
 *         first payment attempt (incomplete -> incomplete_expired) --
 *         exactly the case the previous version got wrong.
 *       - otherwise: the no-card signup trial, active only while
 *         trial_ends_at hasn't passed.
 *
 * Deliberately does NOT gate anything but the dashboard itself -- the
 * public NFC landing page and feedback submission never check this. See
 * proxy.ts and app/dashboard/layout.tsx for where this is (and isn't)
 * enforced.
 */
export function isBillingActive(billing: OrganizationBilling | null): boolean {
  if (!billing) return false;

  if (billing.stripe_subscription_id && (billing.status === "active" || billing.status === "trialing")) {
    return true;
  }

  if (billing.activated_at) return false;

  if (billing.grandfathered_at) return true;

  return billing.trial_ends_at !== null && new Date(billing.trial_ends_at) > new Date();
}
