import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fourth independent review: features/billing/actions.ts was rewritten to
 * close Findings 1 (wrong-plan Checkout race), 2 (superseded Sessions
 * never expired), 7 (incomplete CAS handling), 9 (unproven lease
 * duration), and 10 (customer creation not durably idempotent).
 *
 * Call order for a full, fresh createCheckoutSessionAction attempt:
 * Fifth round (migrations 20260908100000/110000) reordered and extended
 * this: the Stripe customer is resolved FIRST, because the immutable
 * checkout request names it and the database validates that pairing at
 * claim time.
 *
 * Call order for a full, fresh createCheckoutSessionAction attempt:
 *   1. getOrCreateStripeCustomerId: billing-table read, [customers.search
 *      recovery], [customers.create + customers.update], persist
 *      update / lost-race re-read
 *   2. rpc("claim_checkout_attempt", ...) with the built request
 *   3. [if existing_session_id] checkout.sessions.retrieve (expand:
 *      line_items), then either a return (complete+paid), a re-home via
 *      rpc("record_checkout_session", ...), or (mismatch/expired)
 *      checkout.sessions.expire + rpc("release_checkout_attempt", ...) +
 *      rpc("claim_checkout_attempt", ...) again to reclaim
 *   4. rpc("renew_checkout_attempt", ...)
 *   5. checkout.sessions.create(...) -- replaying the STORED request on a
 *      takeover, under the attempt id's idempotency key
 *   6. rpc("record_checkout_session", ...) -- BEFORE validating the Session
 *   7. rpc("finish_checkout_operation", ...) -- frees the lease, keeps the
 *      attempt alive for the customer still on Stripe's page
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
const customersUpdate = vi.fn();
const customersSearch = vi.fn();
const customersList = vi.fn();
const checkoutSessionsCreate = vi.fn();
const checkoutSessionsRetrieve = vi.fn();
const checkoutSessionsExpire = vi.fn();
const checkoutSessionsList = vi.fn();
const billingPortalSessionsCreate = vi.fn();
const subscriptionsRetrieve = vi.fn();

vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({
    customers: { create: customersCreate, update: customersUpdate, search: customersSearch, list: customersList },
    checkout: {
      sessions: { create: checkoutSessionsCreate, retrieve: checkoutSessionsRetrieve, expire: checkoutSessionsExpire, list: checkoutSessionsList },
    },
    subscriptions: { retrieve: subscriptionsRetrieve },
    billingPortal: { sessions: { create: billingPortalSessionsCreate } },
  }),
}));

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

const rpcCalls: Array<{ name: string; args: unknown }> = [];
const rpcQueues: Record<string, Array<{ data: unknown; error: unknown }>> = {};
function defaultRpcImpl(name: string, args: unknown) {
  rpcCalls.push({ name, args });
  const q = rpcQueues[name];
  if (q && q.length > 0) return Promise.resolve(q.shift());
  // The pre-create fence succeeds unless a test says otherwise, so tests of
  // the creation DECISION are not all rewritten as tests of the fence.
  if (name === "mark_stripe_customer_key_sent") return Promise.resolve({ data: true, error: null });
  // R12-01: the checkout-request fence, same treatment -- tests of the
  // creation DECISION should not all become tests of the fence.
  if (name === "mark_checkout_request_sent") return Promise.resolve({ data: true, error: null });
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
  throw new Error("expected the action to redirect, but it returned");
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
  owner_token: string | null;
  is_new_attempt: boolean;
  existing_session_id: string | null;
  existing_interval: string | null;
  existing_price_id: string | null;
  existing_mode: string | null;
  request: unknown;
  retry_safe: boolean;
  request_state: string;
  attempt_created_at: string | null;
}> = {}) {
  return {
    data: [
      {
        attempt_id: "attempt_1",
        owner_token: "owner_1",
        is_new_attempt: true,
        existing_session_id: null,
        existing_interval: null,
        existing_price_id: null,
        existing_mode: null,
        request: null,
        retry_safe: true,
        // R12-01: a fresh attempt has never been sent to Stripe.
        request_state: "unused",
        attempt_created_at: new Date().toISOString(),
        ...overrides,
      },
    ],
    error: null,
  };
}

/**
 * The immutable request an attempt stores and a takeover replays --
 * mirrors buildCheckoutRequest's own output shape. The marker exists so a
 * test can prove the STORED object reached Stripe rather than a freshly
 * rebuilt one.
 */
function storedRequest(priceId: string, marker = "stored") {
  return {
    mode: "subscription",
    customer: "cus_existing",
    client_reference_id: "42",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url:
      "https://velemenytap.example/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}&marker=" + marker,
    cancel_url: "https://velemenytap.example/dashboard/billing?checkout=canceled",
    metadata: { organization_id: "42" },
    subscription_data: { metadata: { organization_id: "42" } },
  };
}

const RENEW_OK = { data: true, error: null };

/**
 * claim_stripe_customer_creation's result. `retrySafe: true` means the
 * frozen idempotency key is still live at Stripe, so replaying create()
 * cannot produce a second Customer; `false` means it may have been pruned
 * ("we generate a new request if a key is reused after the original is
 * pruned") and something else has to establish that none exists.
 */
function customerClaim(overrides: Partial<{
  customer_id: string | null;
  creation_id: string | null;
  started_at: string | null;
  retry_safe: boolean;
  needs_recovery: boolean;
  owner_token: string | null;
}> = {}) {
  return {
    data: [
      {
        customer_id: null,
        creation_id: "creation_1",
        started_at: new Date().toISOString(),
        retry_safe: true,
        // R10-04: by default this identity is one an earlier attempt may
        // already have sent to Stripe, so recovery applies. Tests of the
        // never-used case set this false explicitly.
        needs_recovery: true,
        owner_token: "creation_owner_1",
        ...overrides,
      },
    ],
    error: null,
  };
}

const RECORD_CUSTOMER_OK = { data: true, error: null };
const RECORD_OK = { data: true, error: null };
const RELEASE_OK = { data: true, error: null };
const SEARCH_EMPTY = { data: [] };

function sessionLineItems(priceId: string) {
  return { data: [{ price: { id: priceId } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockImplementation(defaultRpcImpl);
  billingCalls.length = 0;
  rpcCalls.length = 0;
  maybeSingleQueue = [];
  for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];

  process.env.NEXT_PUBLIC_SITE_URL = "https://velemenytap.example";
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

  customersSearch.mockResolvedValue(SEARCH_EMPTY);
  // The canonical enumeration finds nothing and completes, unless a test
  // says otherwise.
  customersList.mockResolvedValue({ data: [], has_more: false });
  customersCreate.mockResolvedValue({ id: "cus_new" });
  customersUpdate.mockResolvedValue({ id: "cus_new" });
  checkoutSessionsCreate.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.com/session" });
  checkoutSessionsRetrieve.mockResolvedValue({
    id: "cs_open",
    status: "open",
    url: "https://checkout.stripe.com/existing",
    line_items: sessionLineItems(MONTHLY_PRICE),
  });
  checkoutSessionsExpire.mockResolvedValue({ id: "cs_open", status: "expired", payment_status: "unpaid" });
  billingPortalSessionsCreate.mockResolvedValue({ url: "https://billing.stripe.com/portal" });
});

describe("createCheckoutSessionAction", () => {
  it("redirects to /onboarding when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe("/onboarding");
  });

  describe("authorization (canManageBilling)", () => {
    it.each(["manager", "staff"] as const)("redirects to unauthorized for role '%s'", async (role) => {
      mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=unauthorized",
      );
      expect(mockGetOrganizationBilling).not.toHaveBeenCalled();
    });

    it.each(["owner", "admin"] as const)("allows role '%s' through", async (role) => {
      mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
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
  });

  describe("already-subscribed guard", () => {
    it.each(["trialing", "active", "past_due", "incomplete", "unpaid", "paused"] as const)(
      "refuses a second Checkout session while status is '%s'",
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
  });

  it("creates a Checkout session for a fresh attempt and redirects to its URL", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    queueRpc("renew_checkout_attempt", RENEW_OK);
    queueRpc("record_checkout_session", RECORD_OK);
    const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
    expect(target).toBe("https://checkout.stripe.com/session");
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("passes a Stripe idempotency key derived from the durable attempt id", async () => {
    queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_xyz" }));
    queue(CUSTOMER_EXISTS);
    queueRpc("renew_checkout_attempt", RENEW_OK);
    queueRpc("record_checkout_session", RECORD_OK);
    await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription", line_items: [{ price: MONTHLY_PRICE, quantity: 1 }] }),
      { idempotencyKey: "checkout:attempt-attempt_xyz" },
    );
  });

  it("carries {CHECKOUT_SESSION_ID} in success_url", async () => {
    queueRpc("claim_checkout_attempt", claimResult());
    queue(CUSTOMER_EXISTS);
    queueRpc("renew_checkout_attempt", RENEW_OK);
    queueRpc("record_checkout_session", RECORD_OK);
    await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ success_url: expect.stringContaining("session_id={CHECKOUT_SESSION_ID}") }),
      expect.anything(),
    );
  });

  describe("Finding 9: lease renewal before the slow session-create call", () => {
    it("renews the attempt right before creating the Session, and aborts if renewal fails (attempt expired mid-flight)", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", { data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });
  });

  /**
   * Stripe documents both halves of this problem explicitly, and neither
   * mechanism is sufficient alone:
   *
   *   "Don't use search in read-after-write flows where strict consistency
   *    is necessary... propagation of new or updated data can be up to an
   *    hour behind during outages." -- /api/customers/search
   *
   *   "You can remove keys from the system automatically after they're at
   *    least 24 hours old. We generate a new request if a key is reused
   *    after the original is pruned." -- /api/idempotent_requests
   *
   * So the frozen key is authoritative from 0 to ~24 hours (where search
   * may lag) and search is authoritative from ~1 hour onwards (where the
   * key may be pruned). The durable creation record is what lets the code
   * know which regime it is in.
   */
  describe("durable customer-creation identity (Stripe search is NOT read-after-write consistent)", () => {
    it("inside the retry-safe window it replays create() under the frozen key and never searches at all", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ creation_id: "creation_abc", retry_safe: true }));
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      // The search is the read-after-write use Stripe rules out; inside
      // this window it is not merely unnecessary but wrong to consult.
      expect(customersSearch).not.toHaveBeenCalled();
      expect(customersCreate).toHaveBeenCalledWith(
        { metadata: { organization_id: "42" } },
        { idempotencyKey: "customer-create:creation_abc" },
      );
      // The mutable name never rides inside the idempotent create, since
      // Stripe rejects a replay whose parameters differ.
      expect(customersUpdate).toHaveBeenCalledWith("cus_new", { name: "Test Org" });
    });

    it("outside the window, a successful search that FINDS the customer adopts it instead of creating", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false }));
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      customersSearch.mockResolvedValue({ data: [{ id: "cus_recovered" }] });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersSearch).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining("42") }));
      expect(customersCreate).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_recovered" }), expect.anything());
    });

    /**
     * The two mechanisms are sound in OPPOSITE directions, and the tests
     * below pin each to the direction it actually holds in:
     *
     *   search  -- lags, so it can only produce false NEGATIVES. A hit is
     *              proof; a miss proves nothing, at any age.
     *   list    -- the canonical read, no consistency caveat. A COMPLETED
     *              enumeration finding nothing is what authorizes creating.
     *
     * Anything that stops the enumeration finishing is "unknown", and the
     * attempt stays pending rather than being resolved either way.
     */
    it("REGRESSION: an empty search alone never authorizes creating, however old the attempt is", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc(
        "claim_stripe_customer_creation",
        customerClaim({ retry_safe: false, started_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString() }),
      );
      customersSearch.mockResolvedValue({ data: [] });
      // The canonical enumeration cannot complete, so the answer is
      // "unknown" -- even though the search came back cleanly empty and
      // the attempt is forty days old.
      customersList.mockRejectedValue(new Error("list unavailable"));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(customersCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "rotate_stripe_customer_creation")).toBe(false);
    });

    it("REGRESSION: a FAILED search is no result either -- but it does not by itself block a decidable case", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ creation_id: "creation_old", retry_safe: false }));
      queueRpc("rotate_stripe_customer_creation", { data: "creation_fresh", error: null });
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      customersSearch.mockRejectedValue(new Error("search unavailable"));
      // The canonical enumeration still completes and finds nothing, which
      // is a sound negative on its own -- search never had to work.
      customersList.mockResolvedValue({ data: [], has_more: false });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersList).toHaveBeenCalled();
      expect(customersCreate).toHaveBeenCalledWith(
        { metadata: { organization_id: "42" } },
        { idempotencyKey: "customer-create:creation_fresh" },
      );
    });

    it("a completed enumeration that FINDS the interrupted attempt's customer adopts it, never creating a second", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false }));
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      // Search has not indexed it yet -- exactly the false negative the
      // enumeration exists to catch.
      customersSearch.mockResolvedValue({ data: [] });
      customersList.mockResolvedValue({
        data: [{ id: "cus_orphaned", metadata: { organization_id: "42" } }],
        has_more: false,
      });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "rotate_stripe_customer_creation")).toBe(false);
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_orphaned" }), expect.anything());
    });

    it("an enumeration that runs out of pages is UNKNOWN, not absent -- the attempt stays pending", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false }));
      customersSearch.mockResolvedValue({ data: [] });
      // Always another page, and never a match: the enumeration can never
      // conclude, so it must not be read as a negative.
      customersList.mockResolvedValue({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `cus_other_${i}`, metadata: { organization_id: "99" } })),
        has_more: true,
      });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(customersCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "rotate_stripe_customer_creation")).toBe(false);
    });

    it("bounds the enumeration by the recorded attempt time rather than scanning all history", async () => {
      const startedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false, started_at: startedAt }));
      queueRpc("rotate_stripe_customer_creation", { data: "creation_fresh", error: null });
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      customersSearch.mockResolvedValue({ data: [] });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      const call = customersList.mock.calls[0][0];
      const expectedGte = Math.floor((Date.parse(startedAt) - 5 * 60 * 1000) / 1000);
      expect(call.created.gte).toBe(expectedGte);
      expect(call.limit).toBe(100);
    });

    it("an attempt with no recorded start time is UNKNOWN -- there is no window to bound a sound negative with", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false, started_at: null }));
      customersSearch.mockResolvedValue({ data: [] });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(customersCreate).not.toHaveBeenCalled();
      expect(customersList).not.toHaveBeenCalled();
    });

    it("a rotation lost to a concurrent caller re-resolves rather than creating under an identity it no longer holds", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: { stripe_customer_id: "cus_winner" }, error: null },
      );
      queueRpc("claim_stripe_customer_creation", customerClaim({ retry_safe: false }));
      queueRpc("rotate_stripe_customer_creation", { data: null, error: null });
      customersSearch.mockResolvedValue({ data: [] });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersCreate).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_winner" }), expect.anything());
    });

    /**
     * R9-03 (round-9 review). Two requests can sit on opposite sides of the
     * 23-hour boundary: one replays the frozen key while the other, seeing a
     * perfectly accurate empty list, rotates and creates. A fresh list cannot
     * prove a concurrent create will not land a moment later, so the decision
     * needs ownership -- not just accuracy.
     */
    it("R9-03: a caller refused the creation lease stands down instead of racing an in-flight create", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ owner_token: null, retry_safe: false }));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(customersCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "rotate_stripe_customer_creation")).toBe(false);
    });

    it("R9-03: rotation is performed under the creation lease the caller holds", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ creation_id: "creation_old", retry_safe: false, owner_token: "creation_owner_1" }));
      queueRpc("rotate_stripe_customer_creation", { data: "creation_fresh", error: null });
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      customersSearch.mockResolvedValue({ data: [] });
      customersList.mockResolvedValue({ data: [], has_more: false });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      const rotate = rpcCalls.find((c) => c.name === "rotate_stripe_customer_creation");
      expect(rotate?.args).toMatchObject({ p_creation_id: "creation_old", p_owner_token: "creation_owner_1" });
    });

    /**
     * R9-04 then R10-04. Round 9's reasoning was that a backfilled legacy row
     * stands for a key the PREVIOUS billing version already used, so replaying
     * it is a real replay. Round 10 showed the flaw: "the row is unresolved"
     * does not establish which key, if any, was ever sent -- and a backfill
     * that assumes one overwrote perfectly valid modern identities, producing
     * a second Customer.
     *
     * The requirement now: an identity a MIGRATION supplied is never treated
     * as a replay, however young it looks. Only a key this app recorded as
     * actually sent can be replayed.
     */
    it("R10-04: a migration-supplied identity is never replayed as if it were sent -- it goes through recovery", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      // What migration 20260910110000 produces for such a row: recovery is
      // required, and retry-safety is withheld regardless of the timestamp.
      queueRpc(
        "claim_stripe_customer_creation",
        customerClaim({ creation_id: "legacy-org-42", retry_safe: false, needs_recovery: true }),
      );
      customersSearch.mockResolvedValue({ data: [] });
      customersList.mockResolvedValue({ data: [], has_more: false });
      queueRpc("rotate_stripe_customer_creation", { data: "creation_rotated", error: null });
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      // The canonical enumeration ran -- the legacy key was NOT replayed on
      // the strength of its age.
      expect(customersList).toHaveBeenCalled();
      expect(customersCreate).toHaveBeenCalledWith(
        { metadata: { organization_id: "42" } },
        { idempotencyKey: "customer-create:creation_rotated" },
      );
    });

    /**
     * R10-04, the other direction. An identity this app minted and has never
     * sent cannot have produced anything, so recovery would be pure cost. This
     * is the ONLY case where creating without recovery is sound, and it is
     * decided by recorded fact rather than by the identity being young.
     */
    it("R10-04: a never-sent identity creates directly, with no enumeration and no rotation", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc(
        "claim_stripe_customer_creation",
        customerClaim({ creation_id: "creation_fresh", retry_safe: false, needs_recovery: false }),
      );
      queueRpc("record_stripe_customer", RECORD_CUSTOMER_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersSearch).not.toHaveBeenCalled();
      expect(customersList).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "rotate_stripe_customer_creation")).toBe(false);
      expect(customersCreate).toHaveBeenCalledWith(
        { metadata: { organization_id: "42" } },
        { idempotencyKey: "customer-create:creation_fresh" },
      );
    });

    /**
     * R10-05. The lease cannot fence a worker that resumes after it expired,
     * so the last thing before the external call is a re-check with enough
     * lease left to cover it. A worker that has lost it must not reach Stripe.
     */
    it("R10-05: a claimant whose lease has lapsed is refused before it can call Stripe", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ needs_recovery: false }));
      queueRpc("mark_stripe_customer_key_sent", { data: false, error: null });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(target).toContain("error=checkout_failed");
      expect(customersCreate).not.toHaveBeenCalled();
    });

    /**
     * R10-05's residual case, which no lease can prevent: a stale worker's
     * create() lands anyway and the row has moved on. The Customer is real and
     * orphaned, and the previous version discarded that fact silently -- which
     * is what made the race invisible rather than merely rare.
     */
    it("R10-05: a Customer created under an identity that has since been superseded is recorded as an orphan", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ needs_recovery: false }));
      // The successor already resolved the organization to a different one.
      queueRpc("record_stripe_customer", { data: false, error: null });
      queue({ data: { stripe_customer_id: null }, error: null }, { data: { stripe_customer_id: "cus_winner" }, error: null });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      const anomaly = rpcCalls.find((c) => c.name === "record_billing_anomaly" && (c.args as { p_kind: string }).p_kind === "orphaned_customer");
      expect(anomaly?.args).toMatchObject({
        p_kind: "orphaned_customer",
        p_detail: { orphanedCustomerId: "cus_new", persistedCustomerId: "cus_winner" },
      });
    });

    /**
     * R11-03 (round-11 review, P2). The test above supplies a persisted winner
     * before the anomaly is checked, so it only ever exercised the ordering in
     * which resolution succeeds. The ordering that matters is the other one.
     *
     * A successor that has rotated the creation identity but not yet persisted
     * its own Customer is a legitimate intermediate state: the persisted id is
     * null, so resolvePersistedCustomerId THROWS. The previous code resolved
     * first and recorded the orphan second, which meant the id of a real
     * Stripe object this process had just created was lost from the very
     * anomaly record offered as the answer to R10-05 -- reproduced by the
     * review as two Customers, zero anomaly rows, zero orphan logs.
     *
     * The requirement: whatever this request knows about an external object it
     * created must be written down before anything that can fail.
     */
    it("R11-03: a created Customer is recorded before resolution, so a throwing resolution cannot lose it", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ needs_recovery: false }));
      queueRpc("record_stripe_customer", { data: false, error: null });
      // Both reads return null: the successor has rotated but not yet
      // persisted, so there is no winner to resolve to and resolution throws.
      queue({ data: { stripe_customer_id: null }, error: null }, { data: { stripe_customer_id: null }, error: null });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toContain("error=checkout_failed");

      const anomaly = rpcCalls.find((c) => c.name === "record_billing_anomaly");
      expect(anomaly?.args).toMatchObject({
        // Deliberately NOT "orphaned_customer": at this point nothing has
        // established a different winner, so a confirmed classification would
        // be invented. The outcome is genuinely unknown and is recorded as such.
        p_kind: "unresolved_customer_creation",
        p_detail: { createdCustomerId: "cus_new", creationId: "creation_1" },
      });
    });

    it("a claim that comes back already resolved returns that customer without creating or searching", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: { stripe_customer_id: null }, error: null });
      queueRpc("claim_stripe_customer_creation", customerClaim({ customer_id: "cus_concurrent", creation_id: null }));
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(customersCreate).not.toHaveBeenCalled();
      expect(customersSearch).not.toHaveBeenCalled();
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_concurrent" }), expect.anything());
    });

    it("record_stripe_customer reporting a superseded identity re-resolves instead of trusting its own creation", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: { stripe_customer_id: "cus_persisted_by_someone_else" }, error: null },
      );
      queueRpc("claim_stripe_customer_creation", customerClaim());
      queueRpc("record_stripe_customer", { data: false, error: null });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_persisted_by_someone_else" }),
        expect.anything(),
      );
    });
  });

  describe("database-backed checkout attempt", () => {
    it("Finding 1: reuses an existing OPEN session only after verifying its ACTUAL Stripe-side price matches the request", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_open", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_open", status: "open", url: "https://checkout.stripe.com/reused", line_items: sessionLineItems(MONTHLY_PRICE) });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toBe("https://checkout.stripe.com/reused");
      expect(checkoutSessionsRetrieve).toHaveBeenCalledWith("cs_open", { expand: ["line_items"] });
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("Finding 1: does NOT trust the row's own bookkeeping fields alone -- a row claiming 'yearly' but an ACTUAL Stripe session still priced monthly is treated as a mismatch, not reused", async () => {
      // Simulates exactly the race the finding describes: the DB row says
      // "yearly" (a newer claim's metadata) but the real Stripe session is
      // still for the OLD monthly plan.
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_open", existing_interval: "yearly", existing_price_id: YEARLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_open", status: "open", url: "https://checkout.stripe.com/monthly-actual", line_items: sessionLineItems(MONTHLY_PRICE) });
      checkoutSessionsExpire.mockResolvedValue({ id: "cs_open", status: "expired", payment_status: "unpaid" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_fresh", is_new_attempt: true }));
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      // Never returned the stale monthly URL for a yearly request.
      expect(target).not.toBe("https://checkout.stripe.com/monthly-actual");
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsExpire).toHaveBeenCalledWith("cs_open");
    });

    it("Finding 2: expires a superseded OPEN session via Stripe's own API before returning a replacement", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_stale", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_stale", status: "open", url: "https://checkout.stripe.com/stale", line_items: sessionLineItems(MONTHLY_PRICE) });
      checkoutSessionsExpire.mockResolvedValue({ id: "cs_stale", status: "expired", payment_status: "unpaid" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_fresh2" }));
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
      expect(checkoutSessionsExpire).toHaveBeenCalledWith("cs_stale");
      expect(target).toBe("https://checkout.stripe.com/session");
    });

    it("Finding 2: handles the race where the superseded session completes DURING expiration -- reconciles it as a real success instead of discarding it", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_raced", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_raced", status: "open", url: "https://checkout.stripe.com/raced", line_items: sessionLineItems(MONTHLY_PRICE) });
      checkoutSessionsExpire.mockRejectedValue(new Error("Session already completed"));
      checkoutSessionsRetrieve.mockResolvedValueOnce({ id: "cs_raced", status: "open", url: "https://checkout.stripe.com/raced", line_items: sessionLineItems(MONTHLY_PRICE) });
      checkoutSessionsRetrieve.mockResolvedValueOnce({ id: "cs_raced", status: "complete", payment_status: "paid", subscription: "sub_raced" });
      // R12-02: a paid Session is settled on the subscription it created --
      // a live one means this IS the current subscription.
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_raced", status: "active" });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));
      expect(target).toContain("checkout=success");
      expect(target).toContain("session_id=cs_raced");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    /**
     * R9-01 (independent round-9 review, P1). The comment above the expire
     * call promises the old Session is closed on Stripe's side "so a
     * customer holding the old link can no longer complete it" -- but the
     * code only stopped short of replacing it when it observed a COMPLETE,
     * PAID Session. If expire() threw and the Session was still open, the
     * attempt was released and a second payable Session was created, so a
     * customer holding both links could complete both and be charged twice.
     *
     * The rule now: an attempt may only be released once the old Session is
     * confirmed to have LEFT the open state. Anything else is unknown, and
     * unknown must not authorize a replacement.
     */
    it("R9-01: expire() failing with the session still OPEN must not authorize a replacement session", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_open_monthly", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_open_monthly", status: "open", url: "https://checkout.stripe.com/still-open",
        line_items: sessionLineItems(MONTHLY_PRICE),
      });
      checkoutSessionsExpire.mockRejectedValue(new Error("Stripe is unavailable"));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R9-01: expire() AND the recheck both failing is also unknown -- no replacement session", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_open_monthly", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve
        .mockResolvedValueOnce({ id: "cs_open_monthly", status: "open", url: "https://checkout.stripe.com/still-open", line_items: sessionLineItems(MONTHLY_PRICE) })
        .mockRejectedValue(new Error("Stripe is unavailable"));
      checkoutSessionsExpire.mockRejectedValue(new Error("Stripe is unavailable"));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      expect(target).toBe("/dashboard/billing?error=checkout_failed");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R9-01: a CONFIRMED expired session still releases and lets a fresh attempt proceed", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_open_monthly", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
        claimResult({ attempt_id: "attempt_after_expiry" }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_open_monthly", status: "open", url: "https://checkout.stripe.com/old", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      checkoutSessionsExpire.mockResolvedValue({ id: "cs_open_monthly", status: "expired", payment_status: "unpaid" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      expect(target).toBe("https://checkout.stripe.com/session");
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(true);
    });
    /**
     * R10-02 (round-10 review, P1). This test used to REQUIRE the defect. It
     * asserted that a complete-but-unpaid Session releases its attempt and a
     * replacement Checkout is created, on the reasoning ("Finding 8") that
     * such a Session is a dead end that would otherwise trap every future
     * attempt.
     *
     * Stripe reaches `complete` while a payment is still processing, so
     * "unpaid" means unresolved, not dead. Releasing there authorized a second
     * subscription while the first payment could still succeed -- and a green
     * suite said it was correct, because the test had been written from the
     * implementation rather than from the requirement.
     *
     * The requirement: a replacement may only be created once the previous
     * Session is confirmed unable to collect.
     */
    it("R10-02: a complete session whose payment is still processing does NOT authorize a replacement", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_unpaid", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_unpaid", status: "complete", payment_status: "unpaid",
        subscription: "sub_processing", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      // The subscription it created has not resolved: the payment can still
      // succeed, so this organization already has a pending obligation.
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_processing", status: "incomplete" });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toContain("error=checkout_failed");

      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R10-02: a complete/unpaid session whose subscription is terminal DOES release -- the customer is not trapped", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_unpaid", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_unpaid", status: "complete", payment_status: "unpaid",
        subscription: "sub_dead", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      // incomplete_expired is Stripe's terminal state for a first payment that
      // never succeeded -- nothing can be collected on it any more.
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_dead", status: "incomplete_expired" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_after_unpaid" }));
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("R10-02: an unreadable subscription is uncertainty, not permission -- no replacement is created", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_unpaid", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_unpaid", status: "complete", payment_status: "unpaid",
        subscription: "sub_unknown", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      subscriptionsRetrieve.mockRejectedValue(new Error("Stripe is down"));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toContain("error=checkout_failed");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    /**
     * R12-01 (round-12 review, P1). The create() and the record of its Session
     * id are two separate steps. A crash between them leaves a REAL, open,
     * payable Session at Stripe and no local pointer — and the rotation branch
     * treated that missing pointer as proof no Session existed, released the
     * attempt, freed the idempotency key, and let the next create() mint a
     * SECOND payable Session.
     *
     * The code said so itself and relied on the negation anyway: "there is no
     * RECORDED Session to lose here, so discarding the attempt costs nothing
     * that this app can see." Not being able to see it is not evidence.
     *
     * The requirement: an attempt that was actually SENT is never discarded on
     * local state alone. Stripe is asked.
     */
    it("R12-01: a sent attempt with no recorded Session reuses the open Session Stripe still has", async () => {
      queueRpc(
        "claim_checkout_attempt",
        // Sent, no recorded Session, and a plan mismatch -- the branch that
        // used to release and re-mint.
        claimResult({
          is_new_attempt: false,
          existing_session_id: null,
          existing_price_id: YEARLY_PRICE,
          retry_safe: false,
          request_state: "sent",
        }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsList.mockResolvedValue({
        data: [{ id: "cs_lost", status: "open" }],
        has_more: false,
      });
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_lost", status: "open", url: "https://checkout.stripe.com/lost",
        line_items: sessionLineItems(MONTHLY_PRICE),
      });
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toBe("https://checkout.stripe.com/lost");
      // The whole point: no second payable Session.
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R12-01: an enumeration that cannot finish is uncertainty, not permission to re-mint", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: null, retry_safe: false, request_state: "sent" }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsList.mockRejectedValue(new Error("Stripe is down"));

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toContain("error=checkout_failed");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R12-01: a completed enumeration finding nothing open DOES authorize a fresh attempt", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: null, retry_safe: false, request_state: "sent" }),
        claimResult({ attempt_id: "attempt_after_probe" }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsList.mockResolvedValue({ data: [{ id: "cs_done", status: "complete" }], has_more: false });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("R12-01: the key is marked sent BEFORE the Stripe call, not after", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      // Capture whether the key was already marked at the instant Stripe was
      // called -- a crash DURING create() must still leave the row saying
      // "this may have produced a Session".
      let markedBeforeCreate = false;
      checkoutSessionsCreate.mockImplementation(() => {
        markedBeforeCreate = rpcCalls.some((c) => c.name === "mark_checkout_request_sent");
        return Promise.resolve({ id: "cs_new", url: "https://checkout.stripe.com/session" });
      });

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      expect(markedBeforeCreate).toBe(true);
      const mark = rpcCalls.find((c) => c.name === "mark_checkout_request_sent");
      expect(mark?.args).toMatchObject({ p_attempt_id: "attempt_1", p_owner_token: "owner_1" });
    });

    /**
     * R12-02 (round-12 review, P1), and a fix I caused myself.
     *
     * A complete+paid Session used to end the operation and return its success
     * URL, keeping the attempt, "because only reconciliation may clear it".
     * R11-01 then stopped reconciliation from clearing any attempt with a
     * recorded Session — so nothing cleared it, and the attempt became
     * permanent.
     *
     * Once that subscription is canceled, hasLiveSubscription correctly allows
     * a new Checkout, the claim hands back the same paid Session, and the
     * customer is redirected to a stale success page forever. Asking for
     * YEARLY returns an old MONTHLY Session's URL, because that branch never
     * consulted planMatches.
     */
    it("R12-02: a paid Session whose subscription is canceled does not trap resubscription", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_old_paid", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
        claimResult({ attempt_id: "attempt_resubscribe" }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_old_paid", status: "complete", payment_status: "paid",
        subscription: "sub_gone", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_gone", status: "canceled" });
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("yearly")));

      // A real new Checkout, for the plan actually asked for -- not the old
      // monthly Session's success page.
      expect(target).toBe("https://checkout.stripe.com/session");
      expect(target).not.toContain("checkout=success");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it("R12-02: a paid Session whose subscription is still live keeps returning its success URL", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_current", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_current", status: "complete", payment_status: "paid",
        subscription: "sub_live", line_items: sessionLineItems(MONTHLY_PRICE),
      });
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_live", status: "active" });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      // Keeping the attempt here is what prevents a duplicate while the local
      // row catches up -- this half of the old behaviour was right.
      expect(target).toContain("checkout=success");
      expect(target).toContain("session_id=cs_current");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("R12-02: a paid Session that created no subscription is an incident, not a release", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_orphan", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({
        id: "cs_orphan", status: "complete", payment_status: "paid",
        subscription: null, line_items: sessionLineItems(MONTHLY_PRICE),
      });

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toContain("error=checkout_failed");
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
      const anomaly = rpcCalls.find((c) => c.name === "record_billing_anomaly");
      expect(anomaly?.args).toMatchObject({ p_kind: "paid_session_without_subscription" });
    });

    it("treats a complete session with payment_status 'no_payment_required' as success too", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_free", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      queue(CUSTOMER_EXISTS);
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_free", status: "complete", payment_status: "no_payment_required", subscription: "sub_free", line_items: sessionLineItems(MONTHLY_PRICE) });
      subscriptionsRetrieve.mockResolvedValue({ id: "sub_free", status: "trialing" });
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));
      expect(target).toContain("checkout=success");
    });

    it("refuses when a concurrent claim is already in flight (a live attempt with no session id yet)", async () => {
      queueRpc("claim_checkout_attempt", claimResult({ owner_token: null, is_new_attempt: false, existing_session_id: null }));
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("Finding 7: fails safe when claim_checkout_attempt itself errors", async () => {
      queueRpc("claim_checkout_attempt", { data: null, error: { message: "db error" } });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
    });

    it("Finding 7: fails safe when release_checkout_attempt reports failure (did not actually own the attempt)", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({ is_new_attempt: false, existing_session_id: "cs_stale", existing_interval: "monthly", existing_price_id: MONTHLY_PRICE }),
      );
      checkoutSessionsRetrieve.mockResolvedValue({ id: "cs_stale", status: "expired", url: null, line_items: sessionLineItems(MONTHLY_PRICE) });
      queueRpc("release_checkout_attempt", { data: false, error: null });
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);
      // release() reporting false is not itself fatal here (the attempt
      // may have already been cleared by someone else) -- but the RPC
      // result IS inspected (not ignored), matching Finding 7's ask.
      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(target).toBe("https://checkout.stripe.com/session");
    });

    it("fails safe when record_checkout_session reports the attempt was superseded (fenced out)", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", { data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
    });

    /**
     * Migration 20260908100000's whole point. A previous operation died
     * after creating a Session at Stripe but before recording it; the next
     * request takes over the SAME attempt id, and must replay the SAME
     * parameters under that attempt's idempotency key -- Stripe rejects a
     * retry whose parameters differ, and deduplicates one whose parameters
     * match, so replaying the stored snapshot is what turns a duplicate
     * subscription into a no-op.
     */
    it("a takeover replays the attempt's STORED request, not a freshly rebuilt one, under the same idempotency key", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({
          attempt_id: "attempt_taken_over",
          owner_token: "owner_2",
          is_new_attempt: false,
          existing_session_id: null,
          existing_interval: "monthly",
          existing_price_id: MONTHLY_PRICE,
          request: storedRequest(MONTHLY_PRICE, "original"),
          retry_safe: true,
        }),
      );
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toBe("https://checkout.stripe.com/session");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
      const [params, options] = checkoutSessionsCreate.mock.calls[0];
      expect((params as { success_url: string }).success_url).toContain("marker=original");
      expect(options).toEqual({ idempotencyKey: "checkout:attempt-attempt_taken_over" });
      // No release: the attempt identity is exactly what must survive here.
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("a stored request that no longer matches this organization's customer is refused rather than replayed", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({
          is_new_attempt: false,
          existing_session_id: null,
          existing_interval: "monthly",
          existing_price_id: MONTHLY_PRICE,
          request: { ...storedRequest(MONTHLY_PRICE), customer: "cus_someone_else" },
          retry_safe: true,
        }),
      );
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);

      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    });

    /**
     * Stripe documents roughly 24 hours of idempotency-key retention, not a
     * permanent guarantee. Past that, replaying the key is no longer
     * deduplicated -- so an attempt that never recorded a Session and is
     * outside the window must be discarded rather than replayed.
     */
    it("an attempt whose idempotency key is past Stripe's retention window is released and replaced, not replayed", async () => {
      queueRpc(
        "claim_checkout_attempt",
        claimResult({
          attempt_id: "attempt_expired_key",
          is_new_attempt: false,
          existing_session_id: null,
          existing_interval: "monthly",
          existing_price_id: MONTHLY_PRICE,
          request: storedRequest(MONTHLY_PRICE, "ancient"),
          retry_safe: false,
        }),
        claimResult({ attempt_id: "attempt_replacement" }),
      );
      queue(CUSTOMER_EXISTS);
      queueRpc("release_checkout_attempt", RELEASE_OK);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const target = await redirectedTo(createCheckoutSessionAction(checkoutFormData("monthly")));

      expect(target).toBe("https://checkout.stripe.com/session");
      const release = rpcCalls.find((c) => c.name === "release_checkout_attempt");
      expect(release?.args).toMatchObject({ p_attempt_id: "attempt_expired_key", p_owner_token: "owner_1" });
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.anything(),
        { idempotencyKey: "checkout:attempt-attempt_replacement" },
      );
    });

    /**
     * A Session that exists at Stripe but was never written down here is
     * invisible to every later attempt -- which is precisely how a customer
     * ends up with two. Whatever is wrong with the Session can be
     * discovered afterwards; its existence cannot be.
     */
    it("records the created Session BEFORE validating it -- a Session Stripe returns without a URL is still persisted", async () => {
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_no_url" }));
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);
      checkoutSessionsCreate.mockResolvedValue({ id: "cs_without_url", url: null });

      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );

      const record = rpcCalls.find((c) => c.name === "record_checkout_session");
      expect(record?.args).toMatchObject({
        p_attempt_id: "attempt_no_url",
        p_owner_token: "owner_1",
        p_session_id: "cs_without_url",
      });
    });

    it("ends the OPERATION on success but keeps the attempt, so the customer on Stripe's page is still reconcilable", async () => {
      queueRpc("claim_checkout_attempt", claimResult({ attempt_id: "attempt_finish" }));
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);
      queueRpc("finish_checkout_operation", { data: true, error: null });

      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));

      const finish = rpcCalls.find((c) => c.name === "finish_checkout_operation");
      expect(finish?.args).toMatchObject({ p_attempt_id: "attempt_finish", p_owner_token: "owner_1" });
      // finish_checkout_operation, never release_checkout_attempt -- the
      // latter would discard the identity while the customer is still
      // mid-checkout.
      expect(rpcCalls.some((c) => c.name === "release_checkout_attempt")).toBe(false);
    });

    it("barrier-controlled concurrency: two concurrent attempts for the same organization never both create a real Stripe session", async () => {
      let claimCallCount = 0;
      rpc.mockImplementation(async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        if (name === "claim_checkout_attempt") {
          claimCallCount += 1;
          if (claimCallCount === 1) {
            return { data: [{ attempt_id: "attempt_first", owner_token: "owner_1", is_new_attempt: true, existing_session_id: null, existing_interval: null, existing_price_id: null, existing_mode: null, request: null, retry_safe: true }], error: null };
          }
          return { data: [{ attempt_id: "attempt_first", owner_token: null, is_new_attempt: false, existing_session_id: null, existing_interval: null, existing_price_id: null, existing_mode: null, request: null, retry_safe: false }], error: null };
        }
        const q = rpcQueues[name];
        if (q && q.length > 0) return q.shift();
        if (name === "mark_checkout_request_sent") return { data: true, error: null };
        return { data: null, error: null };
      });
      queue(CUSTOMER_EXISTS);
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);

      const first = redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      const second = redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      const [firstTarget, secondTarget] = await Promise.all([first, second]);

      expect(firstTarget).toBe("https://checkout.stripe.com/session");
      expect(secondTarget).toBe("/dashboard/billing?error=checkout_failed");
      expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("getOrCreateStripeCustomerId error handling", () => {
    it("fails safe when organization_billing has no row at all", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue({ data: null, error: null });
      expect(await redirectedTo(createCheckoutSessionAction(checkoutFormData()))).toBe(
        "/dashboard/billing?error=checkout_failed",
      );
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it("resolves a concurrent-update race by using the id another concurrent call already persisted", async () => {
      queueRpc("claim_checkout_attempt", claimResult());
      queue(
        { data: { stripe_customer_id: null }, error: null },
        { data: { stripe_customer_id: "cus_winner" }, error: null },
      );
      queueRpc("claim_stripe_customer_creation", customerClaim());
      queueRpc("record_stripe_customer", { data: false, error: null });
      queueRpc("renew_checkout_attempt", RENEW_OK);
      queueRpc("record_checkout_session", RECORD_OK);
      await redirectedTo(createCheckoutSessionAction(checkoutFormData()));
      expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_winner" }), expect.anything());
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
  });

  it("redirects to the Stripe Billing Portal URL", async () => {
    queue({ data: { stripe_customer_id: "cus_existing" }, error: null });
    expect(await redirectedTo(createPortalSessionAction())).toBe("https://billing.stripe.com/portal");
  });

  it("redirects to no_subscription when the organization has no stripe_customer_id yet", async () => {
    queue({ data: { stripe_customer_id: null }, error: null });
    expect(await redirectedTo(createPortalSessionAction())).toBe("/dashboard/billing?error=no_subscription");
  });
});
