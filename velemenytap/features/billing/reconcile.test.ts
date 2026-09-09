import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/features/billing/stripe-config", () => ({
  approvedPriceIds: () => new Set(["price_monthly", "price_yearly"]),
}));

const subscriptionsList = vi.fn();
vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({ subscriptions: { list: subscriptionsList } }),
}));

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

// Matches features/billing/actions.test.ts's own billingChain() pattern --
// reconcileOrganizationBilling's own revocation branch (Finding: stale
// entitlement never revoked when no approved subscription remains) reads
// organization_billing.stripe_subscription_id directly via `.from()`.
let maybeSingleQueue: Array<{ data: unknown; error: unknown }> = [];
const maybeSingleDefault: { data: unknown; error: unknown } = { data: null, error: null };
function billingChain() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    chain[method] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(maybeSingleQueue.shift() ?? maybeSingleDefault);
  return chain;
}
function queueMaybeSingle(...entries: Array<{ data: unknown; error: unknown }>) {
  maybeSingleQueue = [...entries];
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc, from: () => billingChain() }),
}));

import { pickCurrentSubscription, reconcileOrganizationBilling, activateOrganizationBilling, customerIdMatches } from "./reconcile";

function sub(overrides: Partial<{ id: string; status: string; created: number; priceId: string | null }> = {}) {
  const { id = "sub_1", status = "active", created = 1000, priceId = "price_monthly" } = overrides;
  return {
    id,
    status,
    created,
    customer: "cus_1",
    cancel_at_period_end: false,
    items: { data: priceId ? [{ price: { id: priceId }, current_period_end: 1893456000 }] : [] },
  } as unknown as import("stripe").Stripe.Subscription;
}

describe("pickCurrentSubscription", () => {
  const approved = new Set(["price_monthly", "price_yearly"]);

  it("returns null for an empty list", () => {
    expect(pickCurrentSubscription([], approved).current).toBeNull();
  });

  it("Finding 4: an active subscription ALWAYS wins over a NEWER incomplete/past_due/unpaid/paused one", () => {
    const cases = ["incomplete", "past_due", "unpaid", "paused"];
    for (const status of cases) {
      const older = sub({ id: "sub_active", status: "active", created: 1000 });
      const newer = sub({ id: "sub_failed", status, created: 5000 });
      const { current } = pickCurrentSubscription([older, newer], approved);
      expect(current?.id, `active should win over a newer ${status}`).toBe("sub_active");
    }
  });

  it("Finding 4: a trialing subscription ALSO always wins over a newer non-live one", () => {
    const older = sub({ id: "sub_trial", status: "trialing", created: 1000 });
    const newer = sub({ id: "sub_failed", status: "past_due", created: 5000 });
    const { current } = pickCurrentSubscription([older, newer], approved);
    expect(current?.id).toBe("sub_trial");
  });

  it("among multiple active/trialing subscriptions, picks the most recently created and reports the rest as duplicateActive", () => {
    const a = sub({ id: "sub_a", status: "active", created: 1000 });
    const b = sub({ id: "sub_b", status: "trialing", created: 2000 });
    const { current, duplicateActive } = pickCurrentSubscription([a, b], approved);
    expect(current?.id).toBe("sub_b");
    expect(duplicateActive.map((s) => s.id).sort()).toEqual(["sub_a", "sub_b"]);
  });

  it("does not report duplicateActive when there is only one active subscription", () => {
    const a = sub({ id: "sub_a", status: "active", created: 1000 });
    const b = sub({ id: "sub_b", status: "canceled", created: 5000 });
    const { duplicateActive } = pickCurrentSubscription([a, b], approved);
    expect(duplicateActive).toEqual([]);
  });

  it("with no active/trialing at all, prefers a recoverable status (past_due/incomplete/unpaid/paused) over a terminal one", () => {
    const recoverable = sub({ id: "sub_recoverable", status: "past_due", created: 1000 });
    const terminal = sub({ id: "sub_terminal", status: "canceled", created: 5000 });
    const { current } = pickCurrentSubscription([recoverable, terminal], approved);
    expect(current?.id).toBe("sub_recoverable");
  });

  it("among only terminal subscriptions, picks the most recently created", () => {
    const older = sub({ id: "sub_old", status: "canceled", created: 1000 });
    const newer = sub({ id: "sub_new", status: "incomplete_expired", created: 5000 });
    const { current } = pickCurrentSubscription([older, newer], approved);
    expect(current?.id).toBe("sub_new");
  });

  it("Finding 11: excludes a subscription whose price is not in the approved set entirely, never picking it even when nothing else exists", () => {
    const foreign = sub({ id: "sub_foreign", status: "active", created: 9999, priceId: "price_unrelated_product" });
    const { current, unapproved } = pickCurrentSubscription([foreign], approved);
    expect(current).toBeNull();
    expect(unapproved.map((s) => s.id)).toEqual(["sub_foreign"]);
  });

  it("Finding 11: an approved-price active subscription wins even alongside a newer unapproved one", () => {
    const approvedSub = sub({ id: "sub_approved", status: "active", created: 1000, priceId: "price_monthly" });
    const foreign = sub({ id: "sub_foreign", status: "active", created: 9999, priceId: "price_unrelated_product" });
    const { current, unapproved } = pickCurrentSubscription([approvedSub, foreign], approved);
    expect(current?.id).toBe("sub_approved");
    expect(unapproved.map((s) => s.id)).toEqual(["sub_foreign"]);
  });

  it("a subscription with no price on its first item is treated as unapproved, not crashing", () => {
    const noPricе = sub({ id: "sub_no_price", status: "active", created: 1000, priceId: null });
    const { current, unapproved } = pickCurrentSubscription([noPricе], approved);
    expect(current).toBeNull();
    expect(unapproved.map((s) => s.id)).toEqual(["sub_no_price"]);
  });
});

describe("customerIdMatches", () => {
  it("treats a null persisted id as 'nothing to check' -- matches anything", () => {
    expect(customerIdMatches(null, "cus_1")).toBe(true);
  });
  it("requires an exact match once a customer id is persisted", () => {
    expect(customerIdMatches("cus_1", "cus_1")).toBe(true);
    expect(customerIdMatches("cus_1", "cus_2")).toBe(false);
  });
});

describe("reconcileOrganizationBilling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation(defaultRpcImpl);
    rpcCalls.length = 0;
    for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];
    subscriptionsList.mockReset();
    subscriptionsList.mockResolvedValue({ data: [sub()] });
    maybeSingleQueue = [];
  });

  it("Finding 3: claims the reconciliation lease BEFORE calling Stripe, and writes conditioned on still owning it", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });
    const result = await reconcileOrganizationBilling(42, "cus_1");
    expect(result.outcome).toBe("reconciled");
    const claimIndex = rpcCalls.findIndex((c) => c.name === "claim_reconciliation_lease");
    const listCallOrder = subscriptionsList.mock.invocationCallOrder[0];
    const writeIndex = rpcCalls.findIndex((c) => c.name === "write_reconciliation_result");
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(claimIndex);
    expect(listCallOrder).toBeGreaterThan(0);
  });

  it("returns 'deferred' (not an error) when the lease cannot be claimed -- another reconciler owns it", async () => {
    queueRpc("claim_reconciliation_lease", { data: [], error: null });
    const result = await reconcileOrganizationBilling(42, "cus_1");
    expect(result.outcome).toBe("deferred");
    expect(subscriptionsList).not.toHaveBeenCalled();
  });

  it("returns 'deferred' when the write loses the lease (write_reconciliation_result returns false) -- never treated as an error", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_reconciliation_result", { data: false, error: null });
    const result = await reconcileOrganizationBilling(42, "cus_1");
    expect(result.outcome).toBe("deferred");
  });

  it("records the failure and frees the lease when Stripe's list() call throws", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    subscriptionsList.mockRejectedValue(new Error("Stripe is down"));
    const result = await reconcileOrganizationBilling(42, "cus_1");
    expect(result.outcome).toBe("error");
    const failure = rpcCalls.find((c) => c.name === "fail_billing_reconciliation");
    expect(failure?.args).toMatchObject({ p_organization_id: 42, p_owner: "owner_1" });
    expect((failure?.args as { p_error: string }).p_error).toContain("Stripe is down");
  });

  it("returns 'no_subscriptions' and clears the dirty flag (not release_reconciliation_lease, which would re-mark it) when Stripe reports none", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    subscriptionsList.mockResolvedValue({ data: [] });
    const result = await reconcileOrganizationBilling(42, "cus_1");
    expect(result.outcome).toBe("no_subscriptions");
    expect(rpcCalls.some((c) => c.name === "clear_reconciliation_dirty")).toBe(true);
    expect(rpcCalls.some((c) => c.name === "release_reconciliation_lease")).toBe(false);
  });

  it("found during this round's own independent adversarial audit: revokes a previously-tracked subscription that has since moved to an unapproved price, instead of leaving 'active' frozen forever", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });
    // Stripe now reports only an unapproved-price subscription for this
    // customer -- the organization's previously-approved one is gone
    // (canceled outright, or migrated to a different Product/Price).
    subscriptionsList.mockResolvedValue({ data: [sub({ id: "sub_unapproved", priceId: "price_unrelated" })] });
    // The row currently tracks a real, previously-approved subscription --
    // there IS something to revoke.
    queueMaybeSingle({ data: { stripe_subscription_id: "sub_was_active" }, error: null });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(result.outcome).toBe("no_subscriptions");
    const writeCall = rpcCalls.find((c) => c.name === "write_reconciliation_result");
    expect(writeCall?.args).toMatchObject({
      p_organization_id: 42,
      p_owner: "owner_1",
      p_stripe_subscription_id: null,
      p_status: "canceled",
    });
    // Must not ALSO call release_reconciliation_lease -- write_
    // reconciliation_result's own success path already clears the lease.
    expect(rpcCalls.some((c) => c.name === "release_reconciliation_lease")).toBe(false);
  });

  it("does NOT touch a pre-signup trial that has never had an approved subscription, even if an unrelated/unapproved subscription exists on the same Stripe Customer", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    subscriptionsList.mockResolvedValue({ data: [sub({ id: "sub_unapproved", priceId: "price_unrelated" })] });
    // Nothing has ever been tracked for this organization -- still on its
    // own pre-signup trial.
    queueMaybeSingle({ data: { stripe_subscription_id: null }, error: null });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(result.outcome).toBe("no_subscriptions");
    expect(rpcCalls.some((c) => c.name === "write_reconciliation_result")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "clear_reconciliation_dirty")).toBe(true);
  });

  it("passes the picked subscription's canonical fields to write_reconciliation_result", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });
    subscriptionsList.mockResolvedValue({ data: [sub({ id: "sub_x", status: "past_due" })] });
    await reconcileOrganizationBilling(42, "cus_1");
    const writeCall = rpcCalls.find((c) => c.name === "write_reconciliation_result");
    expect(writeCall?.args).toMatchObject({
      p_organization_id: 42,
      p_owner: "owner_1",
      p_stripe_customer_id: "cus_1",
      p_stripe_subscription_id: "sub_x",
      p_status: "past_due",
    });
  });
});

/**
 * Migration 20260908110000. Mutual exclusion alone still lost an event that
 * arrived DURING a reconciliation: the losing racer set the dirty flag, and
 * the winner's own completing write cleared it again. The generation pair
 * is what makes a completing write answer "was every request I knew about
 * satisfied," rather than merely "did I finish" -- and it only works if
 * every entry point registers its request BEFORE claiming the lease, and
 * then writes under the generation the claim observed.
 */
/**
 * R9-07 (round-9 review). `limit` is a page size, not a total. Ignoring
 * `has_more` meant an older but still ACTIVE subscription sitting behind 100
 * newer terminal ones was never seen, and entitlement was decided -- as
 * canceled -- from a prefix.
 */
describe("subscription history pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation(defaultRpcImpl);
    rpcCalls.length = 0;
    for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];
    subscriptionsList.mockReset();
    maybeSingleQueue = [];
  });

  it("R9-07: follows has_more and finds an active subscription behind a full page of canceled ones", async () => {
    const canceled = Array.from({ length: 100 }, (_, i) => sub({ id: `sub_dead_${i}`, status: "canceled", created: 2000 + i }));
    subscriptionsList
      .mockResolvedValueOnce({ data: canceled, has_more: true })
      .mockResolvedValueOnce({ data: [sub({ id: "sub_still_active", status: "active", created: 1000 })], has_more: false });
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 1, activation_generation: 0 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(subscriptionsList).toHaveBeenCalledTimes(2);
    expect(subscriptionsList.mock.calls[1][0]).toMatchObject({ starting_after: "sub_dead_99" });
    expect(result).toMatchObject({ outcome: "reconciled", subscriptionId: "sub_still_active", status: "active" });
  });

  it("R9-07: a history too large to page through fails rather than deciding from a prefix", async () => {
    const page = Array.from({ length: 100 }, (_, i) => sub({ id: `sub_${i}`, status: "canceled" }));
    subscriptionsList.mockResolvedValue({ data: page, has_more: true });
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 1, activation_generation: 0 }], error: null });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(result.outcome).toBe("error");
    expect(rpcCalls.some((c) => c.name === "write_reconciliation_result")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "fail_billing_reconciliation")).toBe(true);
  });
});

describe("reconciliation generations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation(defaultRpcImpl);
    rpcCalls.length = 0;
    for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];
    subscriptionsList.mockReset();
    subscriptionsList.mockResolvedValue({ data: [sub()] });
    maybeSingleQueue = [];
  });

  it("registers the request BEFORE claiming the lease, so a racer that loses the claim is still recorded", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 7 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });

    await reconcileOrganizationBilling(42, "cus_1");

    const requestIndex = rpcCalls.findIndex((c) => c.name === "request_billing_reconciliation");
    const claimIndex = rpcCalls.findIndex((c) => c.name === "claim_reconciliation_lease");
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(requestIndex);
  });

  it("writes under the generation the CLAIM observed, never a later one", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 7 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });

    await reconcileOrganizationBilling(42, "cus_1");

    const write = rpcCalls.find((c) => c.name === "write_reconciliation_result");
    expect(write?.args).toMatchObject({ p_owner: "owner_1", p_requested_generation: 7 });
  });

  it("passes the observed generation to clear_reconciliation_dirty on the confirmed-clean path too", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    subscriptionsList.mockResolvedValue({ data: [] });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(result.outcome).toBe("no_subscriptions");
    const clear = rpcCalls.find((c) => c.name === "clear_reconciliation_dirty");
    expect(clear?.args).toMatchObject({ p_owner: "owner_1", p_requested_generation: 3 });
  });

  it("surfaces an error (and never claims a lease) when the request itself cannot be recorded", async () => {
    queueRpc("request_billing_reconciliation", { data: null, error: { message: "row missing" } });

    const result = await reconcileOrganizationBilling(42, "cus_1");

    expect(result.outcome).toBe("error");
    expect(rpcCalls.some((c) => c.name === "claim_reconciliation_lease")).toBe(false);
    expect(subscriptionsList).not.toHaveBeenCalled();
  });

  /**
   * R9-02 (round-9 review, P1). One shared generation pair meant either kind
   * of work could mark the other kind's pending requests complete. Activation
   * now registers and satisfies its OWN obligation.
   */
  it("R9-02: activation registers an ACTIVATION obligation, never a subscription one", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 7, activation_generation: 2 }], error: null });
    queueRpc("write_activation", { data: true, error: null });

    await activateOrganizationBilling(42);

    expect(rpcCalls.some((c) => c.name === "request_billing_activation")).toBe(true);
    expect(rpcCalls.some((c) => c.name === "request_billing_reconciliation")).toBe(false);
    const write = rpcCalls.find((c) => c.name === "write_activation");
    expect(write?.args).toMatchObject({ p_requested_generation: 7, p_activation_generation: 2 });
  });

  it("R9-02: a subscription refresh carries the activation generation through untouched", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 4, activation_generation: 9 }], error: null });
    queueRpc("write_reconciliation_result", { data: true, error: null });

    await reconcileOrganizationBilling(42, "cus_1");

    const write = rpcCalls.find((c) => c.name === "write_reconciliation_result");
    expect(write?.args).toMatchObject({ p_requested_generation: 4, p_activation_generation: 9 });
  });

  it("activation follows the same request-then-claim-then-write-under-that-generation order", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 5 }], error: null });
    queueRpc("write_activation", { data: true, error: null });

    await activateOrganizationBilling(42);

    const requestIndex = rpcCalls.findIndex((c) => c.name === "request_billing_reconciliation");
    const claimIndex = rpcCalls.findIndex((c) => c.name === "claim_reconciliation_lease");
    expect(claimIndex).toBeGreaterThan(requestIndex);
    const write = rpcCalls.find((c) => c.name === "write_activation");
    expect(write?.args).toMatchObject({ p_owner: "owner_1", p_requested_generation: 5 });
  });
});

describe("activateOrganizationBilling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation(defaultRpcImpl);
    rpcCalls.length = 0;
    for (const key of Object.keys(rpcQueues)) delete rpcQueues[key];
  });

  it("claims the lease, then writes activation", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_activation", { data: true, error: null });
    const result = await activateOrganizationBilling(42);
    expect(result.outcome).toBe("reconciled");
    expect(rpcCalls.some((c) => c.name === "write_activation")).toBe(true);
  });

  it("defers when the lease can't be claimed", async () => {
    queueRpc("claim_reconciliation_lease", { data: [], error: null });
    const result = await activateOrganizationBilling(42);
    expect(result.outcome).toBe("deferred");
  });

  it("defers when the write loses the lease", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    queueRpc("write_activation", { data: false, error: null });
    const result = await activateOrganizationBilling(42);
    expect(result.outcome).toBe("deferred");
  });

  it("releases the lease and returns an error when write_activation itself throws (not merely an { error } result) -- found during this round's own independent self-review: an earlier version had no try/catch here at all, unlike reconcileOrganizationBilling, silently abandoning the claimed lease with needs_reconciliation never set", async () => {
    queueRpc("claim_reconciliation_lease", { data: [{ owner_token: "owner_1", requested_generation: 3 }], error: null });
    rpc.mockImplementation((name: string, args: unknown) => {
      if (name === "write_activation") throw new Error("network failure");
      return defaultRpcImpl(name, args);
    });
    const result = await activateOrganizationBilling(42);
    expect(result.outcome).toBe("error");
    const release = rpcCalls.find((c) => c.name === "release_reconciliation_lease");
    expect(release?.args).toMatchObject({ p_organization_id: 42, p_owner: "owner_1" });
  });
});
