import { describe, it, expect } from "vitest";
import { isBillingActive, hasLiveSubscription, type OrganizationBilling } from "./status";

function billing(overrides: Partial<OrganizationBilling>): OrganizationBilling {
  return {
    status: "trialing",
    trial_ends_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_id: null,
    grandfathered_at: null,
    activated_at: null,
    ...overrides,
  };
}

describe("isBillingActive", () => {
  it("blocks when there is no billing row at all", () => {
    expect(isBillingActive(null)).toBe(false);
  });

  it("allows an active Stripe subscription", () => {
    expect(isBillingActive(billing({ status: "active", stripe_subscription_id: "sub_1", activated_at: "2026-01-01T00:00:00Z" }))).toBe(true);
  });

  it("allows a no-card trial that hasn't expired yet", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(isBillingActive(billing({ status: "trialing", trial_ends_at: tomorrow }))).toBe(true);
  });

  it("blocks a no-card trial once it has expired", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(isBillingActive(billing({ status: "trialing", trial_ends_at: yesterday }))).toBe(false);
  });

  it("blocks a trial row with no trial_ends_at set (defensive -- shouldn't happen, the provisioning trigger always sets it)", () => {
    expect(isBillingActive(billing({ status: "trialing", trial_ends_at: null }))).toBe(false);
  });

  it("allows a genuine Stripe-side trial (a real subscription in 'trialing' status) regardless of this app's own trial_ends_at", () => {
    // Checkout never requests a Stripe trial (features/billing/actions.ts),
    // so this is rare in practice -- but if one is ever granted manually
    // (e.g. a promo from the Stripe dashboard), Stripe's own status must
    // be trusted, not second-guessed against a local trial_ends_at that
    // may be null, expired, or simply irrelevant once a subscription exists.
    expect(
      isBillingActive(billing({ status: "trialing", trial_ends_at: null, stripe_subscription_id: "sub_1" })),
    ).toBe(true);
  });

  it("blocks a canceled subscription that HAD genuinely activated, even if this app's own (now-irrelevant) trial_ends_at is still in the future", () => {
    const farFuture = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      isBillingActive(
        billing({
          status: "canceled",
          trial_ends_at: farFuture,
          stripe_subscription_id: "sub_1",
          activated_at: "2026-01-01T00:00:00Z",
        }),
      ),
    ).toBe(false);
  });

  it.each(["past_due", "canceled", "incomplete", "incomplete_expired", "unpaid", "paused"] as const)(
    "blocks a real Stripe subscription in status '%s' that HAS genuinely activated before",
    (status) => {
      expect(
        isBillingActive(billing({ status, stripe_subscription_id: "sub_1", activated_at: "2026-01-01T00:00:00Z" })),
      ).toBe(false);
    },
  );

  /**
   * Found during an independent review: the previous version keyed
   * entirely off `stripe_subscription_id` being set at all, so an
   * organization whose subscription had NEVER successfully activated
   * (still just incomplete, or one that expired before ever paying) lost
   * grandfathering/trial access the instant Checkout created the
   * subscription object -- strictly worse off than before it tried to
   * pay. activated_at (set only on a genuine transition to 'active', see
   * the webhook's own comment) is the fix: these statuses, WITHOUT a
   * prior activation, must still fall back to whatever pre-payment grant
   * applies, not block outright.
   */
  describe("never-activated subscription statuses fall back to the pre-payment grant, not blocked outright", () => {
    it("grandfathered -> incomplete (a first payment attempt still pending): access preserved via grandfathering", () => {
      expect(
        isBillingActive(
          billing({ status: "incomplete", stripe_subscription_id: "sub_1", grandfathered_at: "2026-01-01T00:00:00Z" }),
        ),
      ).toBe(true);
    });

    it("grandfathered -> incomplete_expired (the first payment attempt failed/timed out): access still preserved via grandfathering", () => {
      expect(
        isBillingActive(
          billing({
            status: "incomplete_expired",
            stripe_subscription_id: "sub_1",
            grandfathered_at: "2026-01-01T00:00:00Z",
          }),
        ),
      ).toBe(true);
    });

    it("a fresh signup's trial -> incomplete_expired: access still comes from trial_ends_at, not blocked by the abandoned subscription attempt", () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      expect(
        isBillingActive(
          billing({ status: "incomplete_expired", stripe_subscription_id: "sub_1", trial_ends_at: tomorrow }),
        ),
      ).toBe(true);
    });

    it("no grandfathering and no trial left, subscription never activated: blocked", () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      expect(
        isBillingActive(
          billing({ status: "incomplete_expired", stripe_subscription_id: "sub_1", trial_ends_at: yesterday }),
        ),
      ).toBe(false);
    });
  });

  /**
   * past_due recovery: an organization that HAS genuinely activated,
   * currently locked out by a failed payment, regains access the moment
   * the webhook reports 'active' again -- no special-casing needed, this
   * is just the ordinary status check, exercised explicitly here as the
   * recovery-path scenario the task asked for.
   */
  it("past_due recovery: access is restored once status returns to 'active', with activated_at unchanged", () => {
    const activatedAt = "2026-01-01T00:00:00Z";
    expect(
      isBillingActive(billing({ status: "past_due", stripe_subscription_id: "sub_1", activated_at: activatedAt })),
    ).toBe(false);
    expect(
      isBillingActive(billing({ status: "active", stripe_subscription_id: "sub_1", activated_at: activatedAt })),
    ).toBe(true);
  });

  /**
   * active -> canceled -> resubscribe: canceling a genuinely-activated
   * subscription blocks access (activated_at stays set, status isn't
   * active/trialing) -- the resubscribe half (a NEW Checkout session
   * being allowed past this point) is covered by hasLiveSubscription
   * below and features/billing/actions.test.ts, since isBillingActive
   * itself only governs dashboard access, not Checkout eligibility.
   */
  it("active -> canceled: access is blocked once canceled, even though the organization did genuinely activate", () => {
    const activatedAt = "2026-01-01T00:00:00Z";
    expect(
      isBillingActive(billing({ status: "active", stripe_subscription_id: "sub_1", activated_at: activatedAt })),
    ).toBe(true);
    expect(
      isBillingActive(billing({ status: "canceled", stripe_subscription_id: "sub_1", activated_at: activatedAt })),
    ).toBe(false);
  });

  describe("grandfathering (pre-existing organizations backfilled when billing was introduced)", () => {
    it("allows a grandfathered organization with no trial_ends_at and no subscription at all", () => {
      expect(
        isBillingActive(billing({ status: "trialing", trial_ends_at: null, grandfathered_at: "2026-09-07T00:00:00Z" })),
      ).toBe(true);
    });

    it("never expires -- unlike the signup trial, an old grandfathered_at still grants access", () => {
      const longAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      expect(isBillingActive(billing({ trial_ends_at: null, grandfathered_at: longAgo }))).toBe(true);
    });

    it("stops applying once the organization has genuinely activated a real Stripe subscription that then lapses", () => {
      expect(
        isBillingActive(
          billing({
            status: "canceled",
            stripe_subscription_id: "sub_1",
            grandfathered_at: "2026-09-07T00:00:00Z",
            activated_at: "2026-09-08T00:00:00Z",
          }),
        ),
      ).toBe(false);
    });

    it("a real active Stripe subscription is still allowed for a grandfathered organization that has since subscribed", () => {
      expect(
        isBillingActive(
          billing({
            status: "active",
            stripe_subscription_id: "sub_1",
            grandfathered_at: "2026-09-07T00:00:00Z",
            activated_at: "2026-09-08T00:00:00Z",
          }),
        ),
      ).toBe(true);
    });
  });
});

/**
 * hasLiveSubscription is Checkout's own "is a second, concurrent
 * subscription attempt actually safe to allow" question -- deliberately a
 * different question from isBillingActive's "should the dashboard render
 * right now." Found during an independent review: the previous guard
 * blocked a new Checkout for ANY non-null stripe_subscription_id,
 * including terminal states (canceled, incomplete_expired) that must
 * allow a fresh attempt -- see features/billing/actions.ts and
 * DECISIONS.md for the full transition table this set was derived from.
 */
describe("hasLiveSubscription", () => {
  it("false when there is no billing row, or no subscription id at all", () => {
    expect(hasLiveSubscription(null)).toBe(false);
    expect(hasLiveSubscription({ status: "active", stripe_subscription_id: null })).toBe(false);
  });

  it.each(["trialing", "active", "past_due", "incomplete", "unpaid", "paused"] as const)(
    "true for status '%s' -- a live or recoverable subscription a new Checkout must not duplicate",
    (status) => {
      expect(hasLiveSubscription({ status, stripe_subscription_id: "sub_1" })).toBe(true);
    },
  );

  it.each(["canceled", "incomplete_expired"] as const)(
    "false for status '%s' -- a terminal, dead-end state a new Checkout must be allowed past",
    (status) => {
      expect(hasLiveSubscription({ status, stripe_subscription_id: "sub_1" })).toBe(false);
    },
  );
});
