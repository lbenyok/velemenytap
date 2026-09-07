import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Second independent review, Finding 2: the previous lease design (a bare
 * `pending_checkout_session_id`/`pending_checkout_expires_at` pair, no
 * compare-and-swap) had real gaps -- no owner/attempt token, application-
 * clock-based lease decisions, a time-bucketed Stripe idempotency key that
 * changed on every retry, no reconciliation of a completed session once
 * the local lease expired, and an open session for one plan reusable for
 * a different one. Replaced with a durable checkout-attempt model
 * (supabase/migrations/20260907200000): claim_checkout_attempt/
 * record_checkout_session/release_checkout_attempt, all compare-and-swap'd
 * on an opaque attempt id, all lease decisions made with clock_timestamp()
 * inside the database, never the application server's own clock.
 *
 * Call order for a full, fresh createCheckoutSessionAction attempt
 * (claimAndCreateCheckoutSession's own sequence, see actions.ts):
 *   1. rpc("claim_checkout_attempt", ...)
 *   2. [if existing_session_id] checkout.sessions.retrieve(...), then
 *      either a return (complete), rpc("record_checkout_session", ...) to
 *      re-home a reused session under a NEW attempt id, or
 *      rpc("release_checkout_attempt", ...) + rpc("claim_checkout_attempt",
 *      ...) again to reclaim
 *   3. getOrCreateStripeCustomerId's own billing-table read, and (only if
 *      no stripe_customer_id yet) its persist update / lost-race re-read
 *   4. checkout.sessions.create(...)
 *   5. rpc("record_checkout_session", ...)
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

vi.mock("@/features/billing/stripe-config", () => ({
  // This file tests actions.ts's own checkout/lease/authorization logic --
  // Stripe environment/Price validation itself is covered separately in
  // stripe-config.test.ts. Resolves immediately (no-op) here so it never
  // gates or interferes with these tests.
  assertStripeConfigurationValid: vi.fn().mockResolvedValue(undefined),
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
 * builder against organization_billing -- used ONLY by
 * getOrCreateStripeCustomerId now (the checkout-lease logic itself moved
 * entirely to RPC calls, mocked separately below via `rpc`).
 */
const billingCalls: Array<{ method: string; args: unknown[] }> = [];
let maybeSingleQueue: Array<{ data: unknown; error: unknown }> = [];
const maybeSingleDefault: { data: unknown; error: unknown } = { data: null, error: null };

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

/**
 * Per-RPC-name queues -- claim_checkout_attempt/record_checkout_session/
 * release_checkout_attempt are semantically distinct calls with their own
 * shapes, called in a branching (not strictly linear) order, so each gets
 * its own FIFO queue rather than sharing one global sequence.
 */
const rpcCalls: Array<{ name: string; args: unknown }> = [];
const rpcQueues: Record<string, Array<{ data: unknown; error: unknown }>> = {};
function defaultRpcImpl(name: string, args: unknown) {
  rpcCalls.push({ name, args });
  const q = rpcQueues[name];
  if (q && q.length > 0) return Promise.resolve(q.shift());
  return Promise.resolve({ data: null, error: null });
}
const rpc = vi.fn(defaultRpcImpl);
function queueRpc(name: string, ...entries: Array<{ data: unknown; error: unknown }>) {
  rpcQueues[name] = [...(rpcQueues[name] ?? []), ...entries];
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => billingChain(), rpc }),
}));

import { createCheckoutSessionAction, createPortalSessionAction } from "./actions";

const OWNER_ORG = { id: 42, name: "Test Org", slug: "test-org", role: "owner" as const };
const MONTHLY_PRICE = "price_monthly_test";
const YEARLY_PRICE = "price_yearly_test";

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

const CUSTOMER_EXISTS = { data: { stripe_customer_id: "cus_existing" }, error: null };

function claimResult(overrides: Partial<{
  attempt_id: string;
  is_new_attempt: boolean;
  existing_session_id: string | null;
  existing_interval: string | null;
  existing_price_id: string | null;
  existing_mode: string | null;
}> = {}) {
  return {
    data: [
      {
        attempt_id: "attempt_1",
        is_new_attempt: true,
        existing_session_id: null,
        existing_interval: null,
        existing_price_id: null,
        existing_mode: null,
        ...overrides,
      },
    ],
    error: null,
  };
}

const RECORD_OK = { data: true, error: null };
const RELEASE_OK = { data: true, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() only resets call history, not a custom
  // .mockImplementation() a PRIOR test may have installed (e.g. the
  // concurrent-attempts test below) -- explicitly restore the shared
  // queue-based default every test so one test's override can never leak
  // into the next.
  rpc.mockImplementation(defaultRpcImpl);
  billingCalls.length = 0;
  rpcCalls.length = 0;
  maybeSingleQueue = [];
  for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];

  process.env.NEXT_PUBLIC_SITE_URL = "https://veleminytap.example";
  process.env.STRIPE_PRICE_ID_MONTHLY = MONTHLY_PRICE;
  process.env.STRIPE_PRICE_ID_YEARLY = YEARLY_PRICE;

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
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);
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
        queueRpc("claim_checkout_attempt", claimResult());
        queue(CUSTOMER_EXISTS);
        queueRpc("record_checkout_session", RECORD_OK);
        const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
        expect(target).toBe("https://checkout.stripe.com/session");
      },
    );
  });

  it("creates a Checkout session and redirects to its URL for an organization with no existing subscription", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    queueRpc("record_checkout_session", RECORD_OK);
    const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
    expect(target).toBe("https://checkout.stripe.com/session");
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("passes a Stripe idempotency key derived from the durable attempt id, not a time bucket", async () => {
    queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_xyz" }));
    queue(CUSTOMER_EXISTS);
    queueRpc("record_checkout_session", RECORD_OK);
    await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription", line_items: [{ price: MONTHLY_PRICE, quantity: 1 }] }),
      { idempotencyKey: "checkout:attempt-attempt_xyz" },
    );
  });

  it("carries {CHECKOUT_SESSION_ID} in success_url for server-side verification on return, not a bare query flag", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    queueRpc("record_checkout_session", RECORD_OK);
    await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ success_url: expect.stringContaining("session_id={CHECKOUT_SESSION_ID}") }),
      expect.anything(),
    );
  });

  it("falls back to the checkout_failed error page if Stripe returns no session URL", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    checkoutSessionsCreate.mockResolvedValue({ id: "cs_new", url: null });
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  it("falls back to the checkout_failed error page if Stripe itself throws", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    checkoutSessionsCreate.mockRejectedValue(new Error("Stripe is down"));
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
      "/dashboard/billing?error=checkout_failed",
    );
  });

  describe("getOrCreateStripeCustomerId (via createCheckoutSessionAction)", () => {
    it("fails safe (checkout_failed) instead of creating an orphaned Stripe customer when organization_billing has no row at all", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("fails safe when reading organization_billing errors", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: null, error: { message: "connection reset" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("reuses an existing stripe_customer_id without creating a new Stripe customer", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" }),
        expect.anything(),
      );
    });

    it("creates a new Stripe customer (with a stable, organization-scoped idempotency key) and persists it when none exists yet", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: { stripe_customer_id: "cus_new" }, error: null },
      );
      queueRpc("record_checkout_session", RECORD_OK);
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
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: null, error: null },
        { data: { stripe_customer_id: "cus_winner" }, error: null },
      );
      queueRpc("record_checkout_session", RECORD_OK);
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(customersCreate).toHaveBeenCalledTimes(1);
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_winner" }),
        expect.anything(),
      );
    });

    it("fails safe when both the update and the post-race re-read fail to produce a usable id", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
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
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: null, error: { message: "connection reset" } },
      );
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });
  });

  describe("database-backed checkout attempt (claimAndCreateCheckoutSession)", () => {
    it("reuses an existing OPEN, plan-matching session instead of creating a new one, without ever calling Stripe to create a session", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({
          is_new_attempt: false,
          existing_session_id: "cs_open",
          existing_interval: "monthly",
          existing_price_id: MONTHLY_PRICE,
        }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ status: "open", url: "https://checkout.stripe.com/reused" });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toBe("https://checkout.stripe.com/reused");
      expect(checkoutSessionsRetrieve).toHaveBeenCalledWith("cs_open");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      // Same (unexpired) attempt owned it already -- no re-homing write needed.
      expect(rpcCalls.filter((c) => c.name === "record_checkout_session")).toHaveLength(0);
    });

    it("re-homes a reusable session under a NEW attempt id when the previous attempt's own lease had already expired", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({
          attempt_id: "attempt_new",
          is_new_attempt: true, // the previous attempt's lease had expired -- a fresh one was minted
          existing_session_id: "cs_open",
          existing_interval: "monthly",
          existing_price_id: MONTHLY_PRICE,
        }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_open", status: "open", url: "https://checkout.stripe.com/reused" });
      queueRpc("record_checkout_session", RECORD_OK);
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toBe("https://checkout.stripe.com/reused");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith(
        "record_checkout_session",
        expect.objectContaining({ p_attempt_id: "attempt_new", p_session_id: "cs_open" }),
      );
    });

    it("fails safe if re-homing a reused session loses to a newer attempt in the meantime", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ attempt_id: "attempt_new", is_new_attempt: true, existing_session_id: "cs_open", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ status: "open", url: "https://checkout.stripe.com/reused" });
      queueRpc("record_checkout_session", { data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
    });

    it("Finding 2 (completed-session-after-24-hours): a COMPLETED session is still reconciled even though its local claim lease already expired and a new attempt was minted", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ attempt_id: "attempt_new", is_new_attempt: true, existing_session_id: "cs_done_long_ago", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_done_long_ago", status: "complete", url: null });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toContain("checkout=success");
      expect(target).toContain("session_id=cs_done_long_ago");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("Finding 2 (plan switch): an open MONTHLY session is never reused for a YEARLY request -- releases and claims fresh instead", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ attempt_id: "attempt_monthly", is_new_attempt: false, existing_session_id: "cs_monthly", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ status: "open", url: "https://checkout.stripe.com/monthly-open" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_yearly", is_new_attempt: true }));
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      expect(target).toBe("https://checkout.stripe.com/session");
      expect(rpc).toHaveBeenCalledWith("release_checkout_attempt", { p_organization_id: 42, p_attempt_id: "attempt_monthly" });
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ line_items: [{ price: YEARLY_PRICE, quantity: 1 }] }),
        { idempotencyKey: "checkout:attempt-attempt_yearly" },
      );
    });

    it("releases an EXPIRED session's stale attempt and creates a fresh one instead of reusing or blocking", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ attempt_id: "attempt_stale", is_new_attempt: false, existing_session_id: "cs_expired", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ status: "expired", url: null });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_fresh", is_new_attempt: true }));
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("refuses (fails safe to checkout_failed) when a concurrent claim is already in flight (a live attempt with no session id yet)", async () => {
      queueRpc("claim_checkout_attempt", claimResult({ is_new_attempt: false, existing_session_id: null }));
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("fails safe when claim_checkout_attempt itself errors", async () => {
      queueRpc("claim_checkout_attempt", { data: null, error: { message: "db error" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("claims fresh when no attempt exists at all (first-ever checkout attempt)", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
    });

    it("fails safe when persisting the newly-created session (record_checkout_session) itself errors", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", { data: null, error: { message: "db error" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
    });

    it("fails safe when record_checkout_session reports the attempt was superseded (fenced out, zero rows)", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", { data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
    });

    /**
     * Barrier-controlled concurrency: two concurrent createCheckoutSessionAction
     * calls for the SAME organization must never both create a real Stripe
     * Checkout Session. The second call's own claim_checkout_attempt mock
     * simulates the real database function's actual behavior under
     * concurrency (a row lock serializes the two): it reports the FIRST
     * call's still-live attempt, not a second new one.
     */
    it("two concurrent attempts for the same organization: the second reuses/waits on the first's claim rather than creating a second Stripe session", async () => {
      let claimCallCount = 0;
      rpc.mockImplementation(async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        if (name === "claim_checkout_attempt") {
          claimCallCount += 1;
          if (claimCallCount === 1) {
            return { data: [{ attempt_id: "attempt_first", is_new_attempt: true, existing_session_id: null, existing_interval: null, existing_price_id: null, existing_mode: null }], error: null };
          }
          // A second, concurrent caller sees the SAME still-live attempt --
          // the real database function's row lock guarantees this.
          return { data: [{ attempt_id: "attempt_first", is_new_attempt: false, existing_session_id: null, existing_interval: null, existing_price_id: null, existing_mode: null }], error: null };
        }
        const q = rpcQueues[name];
        if (q && q.length > 0) return q.shift();
        return { data: null, error: null };
      });

      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);

      const first = redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      const second = redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      const [firstTarget, secondTarget] = await Promise.all([first, second]);

      expect(firstTarget).toBe("https://checkout.stripe.com/session");
      // The second caller saw a live attempt with no session id yet (still
      // in flight) and correctly refused rather than racing ahead of it.
      expect(secondTarget).toBe("/dashboard/billing?error=checkout_failed");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("a slow Stripe response does not cause the claim to be reused incorrectly -- the same attempt id is used for the eventual create() call", async () => {
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_slow" }));
      queue(CUSTOMER_EXISTS);
      queueRpc("record_checkout_session", RECORD_OK);
      checkoutSessionsCreate.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ id: "cs_new", url: "https://checkout.stripe.com/session" }), 20)),
      );
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "checkout:attempt-attempt_slow" });
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
