import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Found during an independent review: getOrCreateStripeCustomerId's own
 * missing-row/error/concurrency handling, claimAndCreateCheckoutSession's
 * database-backed lease, and createCheckoutSessionAction's authorization
 * and already-subscribed guards, have no black-box e2e hook that can
 * reliably force those exact states -- forcing "organization_billing has
 * no row," "a concurrent request already won the race," or "a lease is
 * already held" through a real browser flow against a real database isn't
 * practical to make deterministic. As with features/onboarding-tour/
 * actions.test.ts (the first Server Action unit test in this codebase),
 * this mocks the collaborators these actions actually call and drives
 * each branch directly. e2e/billing-paywall.spec.ts still covers the
 * externally-observable flow end to end.
 *
 * Call order for a full, fresh createCheckoutSessionAction attempt
 * (claimAndCreateCheckoutSession's own sequence, see actions.ts):
 *   1. the pending-checkout-lease read
 *   2. [if a stale/expired-on-Stripe session was found] a bare release
 *      update -- fire-and-forget, not queued
 *   3. the claim UPDATE's own .select().maybeSingle()
 *   4. getOrCreateStripeCustomerId's own read
 *   5. [only if no stripe_customer_id yet] its persist UPDATE, and on a
 *      lost race, a re-read
 *   6. a bare update recording the new session id -- fire-and-forget, not
 *      queued
 * Every queue(...) call below lists entries in this exact order; a test
 * that returns early (reusing an open session, or finding one already
 * complete) only ever reaches step 1.
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
const checkoutSessionsRetrieve = vi.fn();
const billingPortalSessionsCreate = vi.fn();

vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({
    customers: { create: customersCreate },
    checkout: { sessions: { create: checkoutSessionsCreate, retrieve: checkoutSessionsRetrieve } },
    billingPortal: { sessions: { create: billingPortalSessionsCreate } },
  }),
}));

/**
 * A generic, queue-based stand-in for the admin client's fluent query
 * builder against organization_billing. `select`/`update`/`eq`/`is`/`or`
 * all just record the call (`billingCalls`) and return the same chain
 * object, matching the real builder's fluent API; `.maybeSingle()` pops
 * the next queued `{ data, error }` off `maybeSingleQueue` (falling back
 * to a configurable default once the queue is empty); a chain that's
 * awaited directly WITHOUT `.maybeSingle()` -- this codebase's own
 * fire-and-forget updates (clearing a stale lease, recording a fresh
 * session id) -- resolves to `{ data: null, error: null }`, mirroring
 * supabase-js's own thenable query builder.
 */
const billingCalls: Array<{ method: string; args: unknown[] }> = [];
let maybeSingleQueue: Array<{ data: unknown; error: unknown }> = [];
let maybeSingleDefault: { data: unknown; error: unknown } = { data: null, error: null };

function billingChain() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "update", "eq", "is", "or"]) {
    chain[method] = (...args: unknown[]) => {
      billingCalls.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = () => {
    billingCalls.push({ method: "maybeSingle", args: [] });
    return Promise.resolve(maybeSingleQueue.shift() ?? maybeSingleDefault);
  };
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => billingChain() }),
}));

import { createCheckoutSessionAction, createPortalSessionAction } from "./actions";

const OWNER_ORG = { id: 42, name: "Test Org", slug: "test-org", role: "owner" as const };

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

function queue(...entries: Array<{ data: unknown; error: unknown }>) {
  maybeSingleQueue = [...entries];
}

// Shorthand for the two most common queue entries (the "no lease held"
// read, and a successful claim UPDATE) that most fresh-checkout tests
// share as their first two steps.
const NO_LEASE = { data: { pending_checkout_session_id: null, pending_checkout_expires_at: null }, error: null };
const CLAIM_OK = { data: { organization_id: 42 }, error: null };
const CUSTOMER_EXISTS = { data: { stripe_customer_id: "cus_existing" }, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  billingCalls.length = 0;
  maybeSingleQueue = [];
  maybeSingleDefault = { data: null, error: null };

  mockGetCurrentOrganization.mockResolvedValue(OWNER_ORG);
  mockGetOrganizationBilling.mockResolvedValue({
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_id: null,
    grandfathered_at: null,
    activated_at: null,
  });

  customersCreate.mockResolvedValue({ id: "cus_new" });
  checkoutSessionsCreate.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.com/session" });
  checkoutSessionsRetrieve.mockResolvedValue({ status: "open", url: "https://checkout.stripe.com/existing" });
  billingPortalSessionsCreate.mockResolvedValue({ url: "https://billing.stripe.com/portal" });
});

describe("createCheckoutSessionAction", () => {
  it("redirects to /onboarding when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe("/onboarding");
  });

  /**
   * Found during an independent review: this action used to authorize on
   * organization membership alone, ignoring the role
   * getCurrentOrganization() already returns -- any signed-in member,
   * including manager/staff, could start a real subscription.
   */
  describe("authorization (canManageBilling)", () => {
    it.each(["manager", "staff"] as const)("redirects to unauthorized for role '%s', without touching billing state at all", async (role) => {
      mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=unauthorized",
      );
      expect(mockGetOrganizationBilling).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it.each(["owner", "admin"] as const)("allows role '%s' through to the normal checkout flow", async (role) => {
      mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
      queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
    });
  });

  it("rejects an invalid interval before touching billing state or Stripe at all", async () => {
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData("weekly")))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
    expect(mockGetOrganizationBilling).not.toHaveBeenCalled();
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  /**
   * hasLiveSubscription, not a bare stripe_subscription_id check -- a
   * canceled or never-completed subscription must NOT block a fresh
   * Checkout attempt (see features/billing/status.ts and
   * status.test.ts's own hasLiveSubscription coverage for the full
   * transition table).
   */
  describe("already-subscribed guard (hasLiveSubscription)", () => {
    it.each(["trialing", "active", "past_due", "incomplete", "unpaid", "paused"] as const)(
      "refuses to create a second Checkout session while status is '%s' (a live subscription), without calling Stripe",
      async (status) => {
        mockGetOrganizationBilling.mockResolvedValue({
          status,
          trial_ends_at: null,
          current_period_end: null,
          cancel_at_period_end: false,
          stripe_subscription_id: "sub_existing",
          grandfathered_at: null,
          activated_at: null,
        });
        expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
          "/dashboard/billing?error=already_subscribed",
        );
        expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      },
    );

    it.each(["canceled", "incomplete_expired"] as const)(
      "allows a fresh Checkout attempt when status is '%s' (a terminal, dead-end state)",
      async (status) => {
        mockGetOrganizationBilling.mockResolvedValue({
          status,
          trial_ends_at: null,
          current_period_end: null,
          cancel_at_period_end: false,
          stripe_subscription_id: "sub_old",
          grandfathered_at: null,
          activated_at: "2026-01-01T00:00:00Z",
        });
        queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
        const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
        expect(target).toBe("https://checkout.stripe.com/session");
      },
    );
  });

  it("creates a Checkout session and redirects to its URL for an organization with no existing subscription", async () => {
    queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
    const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
    expect(target).toBe("https://checkout.stripe.com/session");
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("passes a Stripe idempotency key on session creation, scoped to the organization and interval", async () => {
    queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
    await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription" }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("checkout:org-42:monthly:") }),
    );
  });

  it("falls back to the checkout_failed error page if Stripe returns no session URL", async () => {
    queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
    checkoutSessionsCreate.mockResolvedValue({ id: "cs_new", url: null });
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  it("falls back to the checkout_failed error page if Stripe itself throws", async () => {
    queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
    checkoutSessionsCreate.mockRejectedValue(new Error("Stripe is down"));
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  describe("getOrCreateStripeCustomerId (via createCheckoutSessionAction)", () => {
    it("fails safe (checkout_failed) instead of creating an orphaned Stripe customer when organization_billing has no row at all", async () => {
      // The pending-checkout-lease read is the FIRST organization_billing
      // query claimAndCreateCheckoutSession makes -- a missing row is
      // caught right there, before ever reaching getOrCreateStripeCustomerId.
      queue({ data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("fails safe when reading organization_billing errors", async () => {
      queue({ data: null, error: { message: "connection reset" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("reuses an existing stripe_customer_id without creating a new Stripe customer", async () => {
      queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" }),
        expect.anything(),
      );
    });

    it("creates a new Stripe customer (with a stable, organization-scoped idempotency key) and persists it when none exists yet", async () => {
      queue(
        NO_LEASE,
        CLAIM_OK,
        { data: { stripe_customer_id: null }, error: null }, // customer read
        { data: { stripe_customer_id: "cus_new" }, error: null }, // customer persist succeeds
      );
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).toHaveBeenCalledTimes(1);
      expect(customersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Test Org" }),
        expect.objectContaining({ idempotencyKey: "customer-create:org-42" }),
      );
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_new" }),
        expect.anything(),
      );
    });

    it("resolves a concurrent-update race by using the id another concurrent call already persisted, not the one just created", async () => {
      queue(
        NO_LEASE,
        CLAIM_OK,
        { data: { stripe_customer_id: null }, error: null }, // customer read: no customer yet
        { data: null, error: null }, // lost the race -- persist matches zero rows
        { data: { stripe_customer_id: "cus_winner" }, error: null }, // re-read after losing
      );
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).toHaveBeenCalledTimes(1); // still created (unavoidable before knowing about the race)
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_winner" }), // but never used -- the winner's id is used instead
        expect.anything(),
      );
    });

    it("fails safe when both the update and the post-race re-read fail to produce a usable id", async () => {
      queue(
        NO_LEASE,
        CLAIM_OK,
        { data: { stripe_customer_id: null }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      );
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("fails safe when persisting the new Stripe customer id errors outright", async () => {
      queue(
        NO_LEASE,
        CLAIM_OK,
        { data: { stripe_customer_id: null }, error: null },
        { data: null, error: { message: "connection reset" } },
      );
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });
  });

  /**
   * Found during an independent review: a 30-second, time-bucketed Stripe
   * idempotency key alone left a real gap -- two submissions in different
   * buckets, or for different intervals, shared no key and could each
   * create a separate, real Checkout Session. claimAndCreateCheckoutSession
   * closes it with a database-backed lease per organization.
   */
  describe("database-backed checkout lease (claimAndCreateCheckoutSession)", () => {
    it("reuses an existing OPEN session instead of creating a new one, without ever calling Stripe to create a session", async () => {
      queue({
        data: {
          pending_checkout_session_id: "cs_open",
          pending_checkout_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      checkoutSessionsRetrieve.mockResolvedValue({ status: "open", url: "https://checkout.stripe.com/reused" });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/reused");
      expect(checkoutSessionsRetrieve).toHaveBeenCalledWith("cs_open");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("sends the organization straight to the success page when the existing session already completed, without creating a second subscription attempt", async () => {
      queue({
        data: {
          pending_checkout_session_id: "cs_done",
          pending_checkout_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      checkoutSessionsRetrieve.mockResolvedValue({ status: "complete", url: null });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toContain("checkout=success");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("releases an EXPIRED session's stale lease and creates a fresh one instead of reusing or blocking", async () => {
      queue(
        {
          data: {
            pending_checkout_session_id: "cs_expired",
            pending_checkout_expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
          error: null,
        }, // lease read: session found, but stale on Stripe's side
        CLAIM_OK, // claim update (after the bare release update, fire-and-forget, not queued)
        CUSTOMER_EXISTS,
      );
      checkoutSessionsRetrieve.mockResolvedValue({ status: "expired", url: null });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("refuses (fails safe to checkout_failed) when a concurrent claim is already in flight (a valid lease with no session id yet)", async () => {
      queue({
        data: { pending_checkout_session_id: null, pending_checkout_expires_at: new Date(Date.now() + 60_000).toISOString() },
        error: null,
      });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("refuses when the atomic claim UPDATE itself loses a race (matches zero rows)", async () => {
      queue(
        NO_LEASE, // no lease held, per the read
        { data: null, error: null }, // but the claim UPDATE's own WHERE clause still matches nothing -- lost a genuine race
      );
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("claims fresh when no lease exists at all (first-ever checkout attempt)", async () => {
      queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
    });

    it("records the newly-created session's id and expiry after a successful create -- confirmed via the update payload", async () => {
      queue(NO_LEASE, CLAIM_OK, CUSTOMER_EXISTS);
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      const persistCall = billingCalls.find(
        (c) =>
          c.method === "update" &&
          typeof c.args[0] === "object" &&
          c.args[0] !== null &&
          "pending_checkout_session_id" in (c.args[0] as object) &&
          (c.args[0] as Record<string, unknown>).pending_checkout_session_id === "cs_new",
      );
      expect(persistCall).toBeDefined();
    });
  });
});

describe("createPortalSessionAction", () => {
  it("redirects to /onboarding when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    expect(await redirectedTo(createPortalSessionAction())).toBe("/onboarding");
  });

  it.each(["manager", "staff"] as const)("redirects to unauthorized for role '%s'", async (role) => {
    mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=unauthorized");
    expect(billingPortalSessionsCreate).not.toHaveBeenCalled();
  });

  it("redirects to the Stripe Billing Portal URL for an organization with a Stripe customer", async () => {
    queue({ data: { stripe_customer_id: "cus_existing" }, error: null });
    expect(await redirectedTo(createPortalSessionAction())).toBe("https://billing.stripe.com/portal");
  });

  it("redirects to no_subscription when the organization has no stripe_customer_id yet", async () => {
    queue({ data: { stripe_customer_id: null }, error: null });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=no_subscription");
  });

  it("fails safe (portal_failed) when reading organization_billing errors, rather than treating it as no_subscription", async () => {
    queue({ data: null, error: { message: "connection reset" } });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=portal_failed");
  });

  it("falls back to portal_failed if Stripe itself throws", async () => {
    queue({ data: { stripe_customer_id: "cus_existing" }, error: null });
    billingPortalSessionsCreate.mockRejectedValue(new Error("Stripe is down"));
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=portal_failed");
  });
});
