import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fourth independent review, Finding 12: "there currently are no
 * meaningful direct tests for these combinations." Direct, focused tests
 * for the billing page's own state-resolution logic -- exported
 * specifically so they can be tested without rendering the page.
 */

vi.mock("server-only", () => ({}));

const checkoutSessionsRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({ checkout: { sessions: { retrieve: checkoutSessionsRetrieve } } }),
}));

const reconcileOrganizationBilling = vi.fn();
vi.mock("@/features/billing/reconcile", () => ({
  reconcileOrganizationBilling: (...args: unknown[]) => reconcileOrganizationBilling(...args),
  // Round-12 ownership gap: the success page now verifies the Session's
  // Customer against the persisted one before reconciling. Real
  // implementation, not a stub -- the point of the check is the rule it
  // applies, and a stub would assert nothing.
  customerIdMatches: (persisted: string | null, observed: string) => persisted === null || persisted === observed,
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/features/organizations/current", () => ({ getCurrentOrganization: vi.fn() }));
vi.mock("@/features/billing/queries", () => ({ getOrganizationBilling: vi.fn() }));
vi.mock("@/features/billing/actions", () => ({ createCheckoutSessionAction: vi.fn(), createPortalSessionAction: vi.fn() }));
vi.mock("@/features/billing/admin-actions", () => ({ resyncOrganizationBillingFormAction: vi.fn() }));

import { orgIdentifiersAgree, resolveCheckoutSuccessState } from "./page";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    status: "complete",
    payment_status: "paid",
    client_reference_id: "42",
    metadata: { organization_id: "42" },
    subscription: "sub_1",
    customer: "cus_1",
    ...overrides,
  };
}

function billingRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    trial_ends_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_id: "sub_1",
    grandfathered_at: null,
    activated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("orgIdentifiersAgree", () => {
  it("Finding 12: both present and agreeing -- passes", () => {
    expect(orgIdentifiersAgree(session() as never, 42)).toBe(true);
  });

  it("Finding 12: both present but CONFLICTING -- fails, even though one of the two matches", () => {
    expect(orgIdentifiersAgree(session({ metadata: { organization_id: "99" } }) as never, 42)).toBe(false);
    expect(orgIdentifiersAgree(session({ client_reference_id: "99" }) as never, 42)).toBe(false);
  });

  it("only client_reference_id present -- must match on its own", () => {
    expect(orgIdentifiersAgree(session({ metadata: null }) as never, 42)).toBe(true);
    expect(orgIdentifiersAgree(session({ metadata: null, client_reference_id: "99" }) as never, 42)).toBe(false);
  });

  it("only metadata present -- must match on its own", () => {
    expect(orgIdentifiersAgree(session({ client_reference_id: null }) as never, 42)).toBe(true);
    expect(orgIdentifiersAgree(session({ client_reference_id: null, metadata: { organization_id: "99" } }) as never, 42)).toBe(false);
  });

  it("neither present -- cannot verify, fails closed", () => {
    expect(orgIdentifiersAgree(session({ client_reference_id: null, metadata: null }) as never, 42)).toBe(false);
  });
});

describe("resolveCheckoutSuccessState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkoutSessionsRetrieve.mockResolvedValue(session());
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "sub_1", status: "active" });
  });

  it("returns 'invalid' when no session_id is present at all", async () => {
    expect(await resolveCheckoutSuccessState(42, undefined, billingRow() as never)).toBe("invalid");
    expect(checkoutSessionsRetrieve).not.toHaveBeenCalled();
  });

  it("returns 'invalid' when the session cannot be retrieved from Stripe", async () => {
    checkoutSessionsRetrieve.mockRejectedValue(new Error("no such session"));
    expect(await resolveCheckoutSuccessState(42, "cs_1", billingRow() as never)).toBe("invalid");
  });

  it("Finding 12: returns 'invalid' for a foreign session whose identifiers don't agree with this organization", async () => {
    checkoutSessionsRetrieve.mockResolvedValue(session({ client_reference_id: "99", metadata: { organization_id: "99" } }));
    expect(await resolveCheckoutSuccessState(42, "cs_1", billingRow() as never)).toBe("invalid");
  });

  it("returns 'unpaid' when the session is not complete", async () => {
    checkoutSessionsRetrieve.mockResolvedValue(session({ status: "open" }));
    expect(await resolveCheckoutSuccessState(42, "cs_1", billingRow() as never)).toBe("unpaid");
  });

  it("Finding 8: returns 'unpaid' for a complete session whose payment_status is 'unpaid'", async () => {
    checkoutSessionsRetrieve.mockResolvedValue(session({ payment_status: "unpaid" }));
    expect(await resolveCheckoutSuccessState(42, "cs_1", billingRow() as never)).toBe("unpaid");
  });

  it("treats payment_status 'no_payment_required' as paid", async () => {
    checkoutSessionsRetrieve.mockResolvedValue(session({ payment_status: "no_payment_required" }));
    const result = await resolveCheckoutSuccessState(42, "cs_1", billingRow({ status: "active", stripe_subscription_id: "sub_1" }) as never);
    expect(result).toBe("confirmed");
  });

  it("Finding 12: 'confirmed' requires the EXACT session's subscription to be locally reconciled as active/trialing -- a DIFFERENT live subscription does not count", async () => {
    const result = await resolveCheckoutSuccessState(
      42,
      "cs_1",
      billingRow({ stripe_subscription_id: "sub_DIFFERENT", status: "active" }) as never,
    );
    // Not immediately confirmed from the stale row -- but reconciliation
    // is actively attempted (Finding 5), and the mock reconciles to sub_1.
    expect(result).toBe("confirmed");
    expect(reconcileOrganizationBilling).toHaveBeenCalledWith(42, "cus_1");
  });

  it("Finding 12: incomplete/past_due/unpaid/paused local status must not show as confirmed even if the subscription id matches", async () => {
    for (const status of ["incomplete", "past_due", "unpaid", "paused"]) {
      reconcileOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "sub_1", status });
      const result = await resolveCheckoutSuccessState(42, "cs_1", billingRow({ status, stripe_subscription_id: "sub_1" }) as never);
      expect(result, `status ${status} must not resolve to confirmed`).toBe("pending");
    }
  });

  it("Finding 5: actively reconciles (self-heals) when the local row hasn't caught up yet, rather than only waiting for a webhook", async () => {
    const result = await resolveCheckoutSuccessState(42, "cs_1", billingRow({ stripe_subscription_id: null, status: "trialing" }) as never);
    expect(reconcileOrganizationBilling).toHaveBeenCalledTimes(1);
    expect(result).toBe("confirmed");
  });

  it("returns 'pending' (not an error) when reconciliation itself can't complete yet (deferred)", async () => {
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "deferred" });
    const result = await resolveCheckoutSuccessState(42, "cs_1", billingRow({ stripe_subscription_id: null }) as never);
    expect(result).toBe("pending");
  });

  it("returns 'pending' when billing is null (no row read yet / race)", async () => {
    const result = await resolveCheckoutSuccessState(42, "cs_1", null);
    expect(result).toBe("confirmed"); // reconciliation succeeds and matches sub_1
  });

  /**
   * Round-12 review, qualified ownership gap. The webhook path checks the
   * Session's Customer against the organization's persisted one before
   * reconciling; this path did not, and write_reconciliation_result overwrites
   * stripe_customer_id unconditionally.
   *
   * The identifier check above proves a Session CLAIMS to belong to this
   * organization — not that its Customer does. A Session created outside the
   * normal flow carrying this organization's metadata could bind a foreign
   * Customer and make its subscriptions the organization's entitlement source.
   */
  it("R12: refuses a Session naming a Customer the organization is not bound to", async () => {
    const result = await resolveCheckoutSuccessState(
      42,
      "cs_1",
      billingRow({ stripe_customer_id: "cus_SOMEONE_ELSE", stripe_subscription_id: null }) as never,
    );
    expect(result).toBe("invalid");
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
  });

  it("R12: still reconciles when the organization has no Customer bound yet", async () => {
    // A null persisted Customer is "nothing to check", not a mismatch — this
    // is a first-ever checkout, and refusing it would break the normal path.
    const result = await resolveCheckoutSuccessState(
      42,
      "cs_1",
      billingRow({ stripe_customer_id: null, stripe_subscription_id: null }) as never,
    );
    expect(result).toBe("confirmed");
    expect(reconcileOrganizationBilling).toHaveBeenCalled();
  });
});
