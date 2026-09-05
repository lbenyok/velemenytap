import { describe, it, expect } from "vitest";
import { isBillingActive, type OrganizationBilling } from "./status";

function billing(overrides: Partial<OrganizationBilling>): OrganizationBilling {
  return {
    status: "trialing",
    trial_ends_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_id: null,
    ...overrides,
  };
}

describe("isBillingActive", () => {
  it("blocks when there is no billing row at all", () => {
    expect(isBillingActive(null)).toBe(false);
  });

  it("allows an active Stripe subscription", () => {
    expect(isBillingActive(billing({ status: "active", stripe_subscription_id: "sub_1" }))).toBe(true);
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

  it("blocks a canceled subscription even if this app's own (now-irrelevant) trial_ends_at is still in the future", () => {
    const farFuture = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      isBillingActive(
        billing({ status: "canceled", trial_ends_at: farFuture, stripe_subscription_id: "sub_1" }),
      ),
    ).toBe(false);
  });

  it.each(["past_due", "canceled", "incomplete", "incomplete_expired", "unpaid", "paused"] as const)(
    "blocks a real Stripe subscription in status '%s'",
    (status) => {
      expect(isBillingActive(billing({ status, stripe_subscription_id: "sub_1" }))).toBe(false);
    },
  );
});
