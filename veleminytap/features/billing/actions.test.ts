import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Found during an independent review: getOrCreateStripeCustomerId's own
 * missing-row/error/concurrency handling, and createCheckoutSessionAction's
 * already-subscribed guard, have no black-box e2e hook that can reliably
 * force those exact states -- forcing "organization_billing has no row"
 * or "a concurrent request already won the race" through a real browser
 * flow against a real database isn't practical to make deterministic. As
 * with features/onboarding-tour/actions.test.ts (the first Server Action
 * unit test in this codebase), this mocks the collaborators these actions
 * actually call and drives each branch directly. e2e/billing-paywall.spec.ts
 * still covers the externally-observable flow end to end.
 */

vi.mock("server-only", () => ({}));

const { mockGetCurrentOrganization, mockGetOrganizationBilling } = vi.hoisted(() => ({
  mockGetCurrentOrganization: vi.fn(),
  mockGetOrganizationBilling: vi.fn(),
}));

vi.mock("@/features/organizations/current", () => ({
  getCurrentOrganization: mockGetCurrentOrganization,
}));

vi.mock("@/features/billing/queries", () => ({
  getOrganizationBilling: mockGetOrganizationBilling,
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const customersCreate = vi.fn();
const checkoutSessionsCreate = vi.fn();
const billingPortalSessionsCreate = vi.fn();

vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({
    customers: { create: customersCreate },
    checkout: { sessions: { create: checkoutSessionsCreate } },
    billingPortal: { sessions: { create: billingPortalSessionsCreate } },
  }),
}));

const selectMaybeSingle = vi.fn();
const updateMaybeSingle = vi.fn();
const selectArgs = vi.fn();
const updateArgs = vi.fn();

/**
 * A chainable stand-in for the admin client's fluent query builder,
 * covering exactly the two shapes features/billing/actions.ts uses against
 * organization_billing:
 *   .select(cols).eq(col, val).maybeSingle()
 *   .update(payload).eq(col, val).is(col2, val2).select(cols).maybeSingle()
 * `selectArgs`/`updateArgs` record what each call was invoked with, for
 * assertions; `selectMaybeSingle`/`updateMaybeSingle` are the terminal
 * resolutions each test configures.
 */
function adminFrom() {
  return {
    select: (cols: string) => {
      selectArgs("select", cols);
      return {
        eq: (col: string, val: unknown) => {
          selectArgs("eq", col, val);
          return { maybeSingle: selectMaybeSingle };
        },
      };
    },
    update: (payload: unknown) => {
      updateArgs("update", payload);
      return {
        eq: (col: string, val: unknown) => {
          updateArgs("eq", col, val);
          return {
            is: (col2: string, val2: unknown) => {
              updateArgs("is", col2, val2);
              return {
                select: (cols: string) => {
                  updateArgs("select", cols);
                  return { maybeSingle: updateMaybeSingle };
                },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: adminFrom }),
}));

import { createCheckoutSessionAction, createPortalSessionAction } from "./actions";

const ORG = { id: 42, name: "Test Org", slug: "test-org" };

async function redirectedTo(promise: Promise<void>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected createCheckoutSessionAction/createPortalSessionAction to redirect, but it returned");
}

function checkoutFormData(interval = "monthly"): FormData {
  const fd = new FormData();
  fd.set("interval", interval);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentOrganization.mockResolvedValue(ORG);
  mockGetOrganizationBilling.mockResolvedValue({
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_id: null,
    grandfathered_at: null,
  });
  selectMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: "cus_existing" }, error: null });
  updateMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: "cus_new" }, error: null });
  customersCreate.mockResolvedValue({ id: "cus_new" });
  checkoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });
  billingPortalSessionsCreate.mockResolvedValue({ url: "https://billing.stripe.com/portal" });
});

describe("createCheckoutSessionAction", () => {
  it("redirects to /onboarding when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe("/onboarding");
  });

  it("rejects an invalid interval before touching billing state or Stripe at all", async () => {
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData("weekly")))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
    expect(mockGetOrganizationBilling).not.toHaveBeenCalled();
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  /**
   * The billing page itself only ever renders the Checkout forms when
   * there's no stripe_subscription_id yet (app/dashboard/billing/page.tsx's
   * hasSubscription) -- this is the server-side enforcement of that same
   * rule, for a request that reaches this action anyway (stale page state,
   * a replayed submission, or a direct POST). Without it, an organization
   * that already has a live subscription could be charged a second time.
   */
  it("refuses to create a second Checkout session for an organization that already has one, without calling Stripe", async () => {
    mockGetOrganizationBilling.mockResolvedValue({
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      stripe_subscription_id: "sub_existing",
      grandfathered_at: null,
    });
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=already_subscribed",
    );
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses to create a second Checkout session even for a non-active (e.g. past_due) existing subscription -- any stripe_subscription_id at all blocks a new one", async () => {
    mockGetOrganizationBilling.mockResolvedValue({
      status: "past_due",
      trial_ends_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      stripe_subscription_id: "sub_existing",
      grandfathered_at: null,
    });
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=already_subscribed",
    );
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("creates a Checkout session and redirects to its URL for an organization with no existing subscription", async () => {
    const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
    expect(target).toBe("https://checkout.stripe.com/session");
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * Found during an independent review: nothing prevented a double form
   * submission (a double-click before the button disables, or a
   * browser/network-level automatic retry) from creating two separate
   * Stripe Checkout Sessions for the same organization. A Stripe
   * idempotency key, scoped to a short window (not the organization
   * permanently -- Stripe only remembers a key for 24 hours, and a later,
   * genuine resubscribe attempt must not be blocked by an earlier,
   * unrelated one), collapses a rapid duplicate into one Stripe request.
   */
  it("passes a Stripe idempotency key scoped to the organization and interval, not a bare/no key", async () => {
    await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription" }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("checkout:42:monthly:") }),
    );
  });

  it("falls back to the checkout_failed error page if Stripe returns no session URL", async () => {
    checkoutSessionsCreate.mockResolvedValue({ url: null });
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  it("falls back to the checkout_failed error page if Stripe itself throws", async () => {
    checkoutSessionsCreate.mockRejectedValue(new Error("Stripe is down"));
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  /**
   * Found during an independent review: getOrCreateStripeCustomerId used
   * to treat a missing organization_billing row (an org that predates the
   * provisioning trigger and was never backfilled) exactly like "brand new
   * customer, go ahead and create one" -- silently creating a real Stripe
   * customer whose id then never persisted (the following UPDATE matched
   * zero rows, also unchecked). It's now a hard failure instead, since
   * every organization should always have exactly one row.
   */
  describe("getOrCreateStripeCustomerId (via createCheckoutSessionAction)", () => {
    it("fails safe (checkout_failed) instead of creating an orphaned Stripe customer when organization_billing has no row at all", async () => {
      selectMaybeSingle.mockResolvedValue({ data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("fails safe when reading organization_billing errors", async () => {
      selectMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("reuses an existing stripe_customer_id without creating a new Stripe customer", async () => {
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" }),
        expect.anything(),
      );
    });

    it("creates a new Stripe customer and persists it when none exists yet", async () => {
      selectMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: null }, error: null });
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).toHaveBeenCalledTimes(1);
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_new" }),
        expect.anything(),
      );
    });

    /**
     * The concurrency guard itself: `.is("stripe_customer_id", null)` on
     * the persisting UPDATE means a losing concurrent call matches zero
     * rows instead of overwriting the winner's id. This simulates that
     * race by having the update resolve to "no row matched" and the
     * follow-up re-read return a DIFFERENT id than the one this call just
     * created with Stripe -- the winner's id, not the loser's, must be
     * what's actually used.
     */
    it("resolves a concurrent-update race by using the id another concurrent call already persisted, not the one just created", async () => {
      selectMaybeSingle.mockReset();
      selectMaybeSingle.mockResolvedValueOnce({ data: { stripe_customer_id: null }, error: null }); // initial read: no customer yet
      selectMaybeSingle.mockResolvedValueOnce({ data: { stripe_customer_id: "cus_winner" }, error: null }); // re-read after losing the race
      updateMaybeSingle.mockResolvedValue({ data: null, error: null }); // lost the race

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersCreate).toHaveBeenCalledTimes(1); // still created (unavoidable before knowing about the race)
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_winner" }), // but never used -- the winner's id is used instead
        expect.anything(),
      );
    });

    it("fails safe when both the update and the post-race re-read fail to produce a usable id", async () => {
      selectMaybeSingle.mockReset();
      selectMaybeSingle.mockResolvedValueOnce({ data: { stripe_customer_id: null }, error: null }); // initial read
      selectMaybeSingle.mockResolvedValueOnce({ data: null, error: null }); // re-read also fails
      updateMaybeSingle.mockResolvedValue({ data: null, error: null });

      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("fails safe when persisting the new Stripe customer id errors outright", async () => {
      selectMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: null }, error: null });
      updateMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });
  });
});

describe("createPortalSessionAction", () => {
  it("redirects to /onboarding when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    expect(await redirectedTo(createPortalSessionAction())).toBe("/onboarding");
  });

  it("redirects to the Stripe Billing Portal URL for an organization with a Stripe customer", async () => {
    expect(await redirectedTo(createPortalSessionAction())).toBe("https://billing.stripe.com/portal");
  });

  it("redirects to no_subscription when the organization has no stripe_customer_id yet", async () => {
    selectMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: null }, error: null });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=no_subscription");
  });

  it("fails safe (portal_failed) when reading organization_billing errors, rather than treating it as no_subscription", async () => {
    selectMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=portal_failed");
  });

  it("falls back to portal_failed if Stripe itself throws", async () => {
    billingPortalSessionsCreate.mockRejectedValue(new Error("Stripe is down"));
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=portal_failed");
  });
});
