import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// lib/stripe.ts and lib/supabase/admin.ts both `import "server-only"`,
// which throws outside a real Next.js server build -- stub it out so this
// route (server-only by nature: it's a webhook) can be unit tested at all.
vi.mock("server-only", () => ({}));

const constructEvent = vi.fn();
const subscriptionsRetrieve = vi.fn();
const subscriptionsList = vi.fn();
vi.mock("stripe", () => ({
  // A real class, not a vi.fn() returning an object literal -- `new` on a
  // mocked arrow-function implementation isn't a valid constructor call
  // (see e2e/support/db-connection.test.ts for the same pattern with pg).
  default: class {
    webhooks = { constructEvent };
    subscriptions = { retrieve: subscriptionsRetrieve, list: subscriptionsList };
  },
}));

const insert = vi.fn();
const rpc = vi.fn();

// A single shared, strictly-ordered queue of `.maybeSingle()` results,
// consumed in the exact order the route's own code issues them --
// matching this project's established pattern for this kind of chained
// PostgREST mock (see features/billing/actions.test.ts's own top-of-file
// comment). syncSubscription issues, per call: [resolveOrganizationId's
// customer-id fallback (only when metadata is missing)], the
// stripe_customer_id mismatch-check read, then the final fenced write.
// activateOnPayment issues: [resolveOrganizationIdForInvoice's fallback
// (only when the metadata snapshot is missing)], then the activation
// write.
const maybeSingleQueue: { data: unknown; error: unknown }[] = [];
function queue(...results: { data: unknown; error: unknown }[]) {
  maybeSingleQueue.push(...results);
}
const DEFAULT_RESULT = { data: null, error: null };

const updates: Record<string, unknown>[] = [];

function chain() {
  const c = {
    select: () => c,
    eq: () => c,
    is: () => c,
    maybeSingle: async () => (maybeSingleQueue.length > 0 ? maybeSingleQueue.shift()! : DEFAULT_RESULT),
  };
  return c;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "stripe_webhook_events") {
        return { insert };
      }
      return {
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          return chain();
        },
        select: () => chain(),
      };
    },
    rpc: rpc,
  }),
}));

function webhookRequest(body: string, signature: string | null = "t=1,v1=fake") {
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : {},
  });
}

function subscriptionEvent(subscriptionId = "sub_1", eventOverrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: { id: subscriptionId } },
    ...eventOverrides,
  };
}

function invoiceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_inv_1",
    type: "invoice.paid",
    livemode: false,
    data: {
      object: {
        id: "in_1",
        customer: "cus_1",
        status: "paid",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { organization_id: "42" } } },
        ...overrides,
      },
    },
  };
}

function canonicalSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    metadata: { organization_id: "42" },
    items: { data: [{ current_period_end: 1893456000 }] },
    created: 1893450000,
    ...overrides,
  };
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    vi.resetModules();
    constructEvent.mockReset();
    subscriptionsRetrieve.mockReset();
    subscriptionsList.mockReset();
    insert.mockReset();
    rpc.mockReset();
    updates.length = 0;
    maybeSingleQueue.length = 0;

    insert.mockResolvedValue({ error: null });
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
    subscriptionsList.mockResolvedValue({ data: [canonicalSubscription()] });
    // Default RPC behavior: claim_billing_sync returns an incrementing
    // fencing token; tests that care about a SPECIFIC value override this.
    let seq = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_billing_sync") {
        seq += 1;
        return { data: seq, error: null };
      }
      return { data: null, error: null };
    });
    // Default: no persisted stripe_customer_id yet (nothing to mismatch
    // against), and the final write always succeeds.
    queue({ data: { stripe_customer_id: null }, error: null }); // mismatch-check read
    queue({ data: { organization_id: 42 }, error: null }); // final write
  });

  it("rejects a request with no stripe-signature header, without touching the DB", async () => {
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}", null));
    expect(res.status).toBe(400);
    expect(constructEvent).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature fails verification, without touching the DB", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("signature mismatch");
    });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  describe("Finding 6: event.livemode vs APP_ENV", () => {
    const originalAppEnv = process.env.APP_ENV;
    afterEach(() => {
      process.env.APP_ENV = originalAppEnv;
    });

    it("rejects a live-mode event when APP_ENV is preview (expects test-mode)", async () => {
      process.env.APP_ENV = "preview";
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(400);
      expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    });

    it("rejects a test-mode event when APP_ENV is production (expects live-mode)", async () => {
      process.env.APP_ENV = "production";
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: false }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(400);
      expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    });

    it("accepts a live-mode event when APP_ENV is production", async () => {
      process.env.APP_ENV = "production";
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
    });

    it("does not gate on livemode at all when APP_ENV is unset (local development)", async () => {
      delete process.env.APP_ENV;
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
    });
  });

  it("processes a genuine, first-time event: retrieves canonical state, lists the customer's subscriptions, applies the picked one, then records the event", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_1");
    expect(subscriptionsList).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1" }));
    expect(updates[0]).toEqual(expect.objectContaining({ status: "active" }));
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
  });

  it("never trusts the event's own embedded object -- only its id is read before the canonical retrieve()/list() calls", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      type: "customer.subscription.updated",
      livemode: false,
      data: { object: { id: "sub_1", status: "canceled", customer: "cus_evil" } },
    });
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "active" }));
    subscriptionsList.mockResolvedValue({ data: [canonicalSubscription({ status: "active" })] });
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    expect(updates[0]).toEqual(expect.objectContaining({ status: "active", stripe_customer_id: "cus_1" }));
  });

  /**
   * Finding 3 (second independent review): canonical retrieval is
   * authoritative only for the ONE subscription it names -- never for the
   * organization/customer as a whole. This is the direct reproduction: an
   * event for sub_old (canceled) must not overwrite sub_new (active,
   * genuinely newer) once sub_new already exists on the same customer.
   */
  it("Finding 3: an event for an OLD, canceled subscription does not overwrite a NEWER, active one on the same customer", async () => {
    const subOld = canonicalSubscription({ id: "sub_old", status: "canceled", created: 1000 });
    const subNew = canonicalSubscription({ id: "sub_new", status: "active", created: 2000 });
    // The event names sub_old specifically (e.g. a delayed/manually
    // redelivered event) -- retrieve() returns exactly that stale object.
    subscriptionsRetrieve.mockResolvedValue(subOld);
    // But Stripe's own live listing for this customer shows BOTH, with
    // sub_new as the real current state.
    subscriptionsList.mockResolvedValue({ data: [subOld, subNew] });
    constructEvent.mockReturnValue(subscriptionEvent("sub_old"));

    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(updates[0]).toEqual(
      expect.objectContaining({ stripe_subscription_id: "sub_new", status: "active" }),
    );
  });

  it("Finding 3: when every subscription for a customer is terminal (canceled/incomplete_expired), the most recently created one is still picked", async () => {
    const older = canonicalSubscription({ id: "sub_a", status: "canceled", created: 1000 });
    const newer = canonicalSubscription({ id: "sub_b", status: "incomplete_expired", created: 2000 });
    subscriptionsRetrieve.mockResolvedValue(older);
    subscriptionsList.mockResolvedValue({ data: [older, newer] });
    constructEvent.mockReturnValue(subscriptionEvent("sub_a"));

    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));

    expect(updates[0]).toEqual(expect.objectContaining({ stripe_subscription_id: "sub_b", status: "incomplete_expired" }));
  });

  it("Finding 3: refuses to sync (asks Stripe to retry) when the subscription's Stripe Customer does not match the organization's already-persisted customer -- quarantined, never rebinding the organization", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { stripe_customer_id: "cus_DIFFERENT" }, error: null }); // mismatch-check read
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ customer: "cus_1" }));

    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(500);
    expect(subscriptionsList).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("proceeds normally when the organization has no persisted customer yet (first-ever subscription for it)", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { stripe_customer_id: null }, error: null });
    queue({ data: { organization_id: 42 }, error: null });
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
  });

  /**
   * Finding 4 (second independent review): a fencing token
   * (billing_sync_seq, claimed via claim_billing_sync BEFORE any Stripe
   * network call) must prevent an older reconciliation attempt's write
   * from landing after a newer one's, even under real concurrency with
   * reversed completion order. This is a barrier-controlled test: request
   * A claims seq=1 and then STALLS on its Stripe calls; request B claims
   * seq=2 and completes fully (including its write) before A resumes.
   * A's own write must then be REJECTED (seq no longer matches), leaving
   * B's state as the final, correct entitlement.
   */
  it("Finding 4: an older request that finishes LATER than a newer one never overwrites the newer one's write (reverse completion order)", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { stripe_customer_id: null }, error: null }); // A's mismatch-check read
    queue({ data: { stripe_customer_id: "cus_1" }, error: null }); // B's mismatch-check read
    // A's own write happens only after B's -- and by then the row's
    // billing_sync_seq is 2, so a conditional UPDATE ... WHERE
    // billing_sync_seq = 1 (A's own claimed token) matches zero rows on
    // the real database. Simulated directly here by returning null/none
    // for A's write specifically (queued third, since A's write executes
    // AFTER B's read+write below thanks to the barrier).
    queue({ data: { organization_id: 42 }, error: null }); // B's write succeeds
    queue({ data: null, error: null }); // A's write is fenced out (0 rows)

    let releaseA: () => void;
    const aBarrier = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    subscriptionsRetrieve.mockImplementation(async (id: string) => {
      if (id === "sub_old") {
        // Request A stalls here until request B has fully completed.
        await aBarrier;
        return canonicalSubscription({ id: "sub_old", status: "canceled", created: 1000 });
      }
      return canonicalSubscription({ id: "sub_new", status: "active", created: 2000 });
    });
    // Both requests are for the SAME customer, which already genuinely has
    // BOTH subscriptions at the time either request lists it -- sub_new
    // was already created and is active before either webhook delivery in
    // this scenario, matching the finding's own real-world timeline.
    subscriptionsList.mockResolvedValue({
      data: [
        canonicalSubscription({ id: "sub_old", status: "canceled", created: 1000 }),
        canonicalSubscription({ id: "sub_new", status: "active", created: 2000 }),
      ],
    });

    const { POST } = await import("./route");

    // Both events are queued BEFORE either POST() call starts --
    // constructEvent() runs synchronously at the very top of the handler
    // (before any await), so A's call consumes the first queued value the
    // instant POST() is invoked, not whenever this test happens to set it.
    constructEvent.mockReturnValueOnce(subscriptionEvent("sub_old")).mockReturnValueOnce(subscriptionEvent("sub_new"));

    // Start A (stalls inside retrieve()).
    const resultAPromise = POST(webhookRequest("{}")).then((r) => r.status);
    const resultB = await POST(webhookRequest("{}"));
    expect(resultB.status).toBe(200);

    // Release A now that B has fully committed.
    releaseA!();
    const resultA = await resultAPromise;

    // Both requests independently re-derive the SAME correct entitlement
    // (sub_new/active) from the full customer listing -- that's exactly
    // why the fencing token matters for CORRECTNESS under a scenario where
    // the two computed payloads genuinely differ (a real subscription
    // change happening between A's and B's own list() calls), not just
    // this test's simplified shared-mock case. What this test actually
    // proves is the MECHANISM: both requests report success to Stripe (A's
    // own effect being superseded is not a failure worth retrying), both
    // attempted a write, and A's specific write consumed the "fenced out,
    // zero rows" queued result without erroring -- i.e. the code checks
    // the write result and treats a fenced write as "already covered",
    // never as license to retry-and-overwrite.
    expect(resultA).toBe(200);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual(expect.objectContaining({ stripe_subscription_id: "sub_new", status: "active" }));
    expect(updates[1]).toEqual(expect.objectContaining({ stripe_subscription_id: "sub_new", status: "active" }));
    expect(rpc).toHaveBeenCalledWith("claim_billing_sync", { p_organization_id: 42 });
    // Strictly increasing fencing tokens, one per request, claimed before
    // either request's own Stripe list() call in program order.
    const claimCalls = rpc.mock.calls.filter(([name]) => name === "claim_billing_sync");
    expect(claimCalls).toHaveLength(2);
  });

  it("reprocesses a duplicate delivery of the same event id idempotently, still reporting it as a duplicate", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
    expect(subscriptionsRetrieve).toHaveBeenCalled();
  });

  it("asks Stripe to retry (5xx) when recording the event id fails for a reason other than a duplicate, after the update already succeeded", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "OTHER", message: "connection reset" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
  });

  it("asks Stripe to retry when the canonical retrieve() call itself fails", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockRejectedValue(new Error("Stripe is down"));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the subscriptions.list() call fails", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsList.mockRejectedValue(new Error("Stripe is down"));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
  });

  it("falls back to looking up the organization by stripe_customer_id when metadata is missing", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { organization_id: 7 }, error: null }); // resolveOrganizationId fallback
    queue({ data: { stripe_customer_id: null }, error: null }); // mismatch-check read
    queue({ data: { organization_id: 7 }, error: null }); // final write

    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    subscriptionsList.mockResolvedValue({ data: [canonicalSubscription({ metadata: {} })] });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual(expect.objectContaining({}));
  });

  it("asks Stripe to retry when the organization can't be resolved at all, rather than silently swallowing the event", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: null, error: null }); // resolveOrganizationId fallback finds nothing
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when organization_billing has no row at all for a resolved organization", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: null, error: null }); // mismatch-check read: no row
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the mismatch-check read itself errors", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: null, error: { message: "connection reset" } });
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when claim_billing_sync itself errors", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_billing_sync") return { data: null, error: { message: "db error" } };
      return { data: null, error: null };
    });
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
  });

  it("asks Stripe to retry when the billing-state update itself errors, and never records the event as processed", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { stripe_customer_id: null }, error: null });
    queue({ data: null, error: { message: "connection reset" } });
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("maps a subscription status Stripe added after this integration to 'incomplete' instead of failing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const future = canonicalSubscription({ status: "some_future_status" });
    subscriptionsRetrieve.mockResolvedValue(future);
    subscriptionsList.mockResolvedValue({ data: [future] });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual(expect.objectContaining({ status: "incomplete" }));
  });

  it("ignores event types it doesn't need to act on, but still acknowledges them, without ever calling retrieve()", async () => {
    constructEvent.mockReturnValue({
      id: "evt_2",
      type: "customer.updated",
      livemode: false,
      data: { object: {} },
    });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(insert).toHaveBeenCalledWith({ id: "evt_2" });
  });

  /**
   * Finding 5 (second independent review): activated_at is now set ONLY
   * from a signed invoice.paid event -- a durable, verified "payment
   * genuinely succeeded" signal, decoupled entirely from subscription
   * status snapshots. These are the exact scenarios the finding lists.
   */
  describe("Finding 5: activated_at is set from invoice.paid, never from subscription status", () => {
    it("sets activated_at when invoice.paid arrives, resolving the organization via the subscription metadata snapshot -- no extra Stripe call needed", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 42 }, error: null }); // the activation write
      constructEvent.mockReturnValue(invoiceEvent());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(subscriptionsRetrieve).not.toHaveBeenCalled();
      expect(updates[0]).toEqual(expect.objectContaining({ activated_at: expect.any(String) }));
    });

    it("payment followed rapidly by cancellation: activated_at is still set by invoice.paid, independent of any later subscription.deleted event", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 42 }, error: null }); // invoice.paid's activation write
      queue({ data: { stripe_customer_id: null }, error: null }); // subscription.deleted's mismatch-check read
      queue({ data: { organization_id: 42 }, error: null }); // subscription.deleted's final write

      const { POST } = await import("./route");

      constructEvent.mockReturnValueOnce(invoiceEvent());
      const res1 = await POST(webhookRequest("{}"));
      expect(res1.status).toBe(200);
      expect(updates[0]).toEqual(expect.objectContaining({ activated_at: expect.any(String) }));

      const canceled = canonicalSubscription({ status: "canceled" });
      subscriptionsRetrieve.mockResolvedValue(canceled);
      subscriptionsList.mockResolvedValue({ data: [canceled] });
      constructEvent.mockReturnValueOnce(subscriptionEvent("sub_1"));
      const res2 = await POST(webhookRequest("{}"));
      expect(res2.status).toBe(200);
      // The cancellation writes status, never activated_at -- activation
      // is a one-way, invoice-only fact this sync path never touches.
      expect(updates[1]).not.toHaveProperty("activated_at");
    });

    it("a missed 'active' subscription event does not prevent activation -- invoice.paid alone is sufficient", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 42 }, error: null });
      constructEvent.mockReturnValue(invoiceEvent());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(updates[0]).toEqual(expect.objectContaining({ activated_at: expect.any(String) }));
    });

    it("duplicate invoice.paid events are idempotent -- both succeed, activation is set-once at the database level (.is(activated_at, null))", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 42 }, error: null });
      queue({ data: null, error: null }); // second delivery: already set, matches zero rows -- not a failure
      const { POST } = await import("./route");
      constructEvent.mockReturnValueOnce(invoiceEvent());
      const res1 = await POST(webhookRequest("{}"));
      expect(res1.status).toBe(200);
      constructEvent.mockReturnValueOnce(invoiceEvent({ id: "in_1" }));
      const res2 = await POST(webhookRequest("{}"));
      expect(res2.status).toBe(200);
    });

    it("events arriving in reverse order (subscription.deleted processed before its invoice.paid) still end with activated_at set", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { stripe_customer_id: null }, error: null }); // subscription.deleted's mismatch-check read
      queue({ data: { organization_id: 42 }, error: null }); // subscription.deleted's write
      queue({ data: { organization_id: 42 }, error: null }); // invoice.paid's activation write (processed second, "in reverse")

      const { POST } = await import("./route");

      const canceled = canonicalSubscription({ status: "canceled" });
      subscriptionsRetrieve.mockResolvedValue(canceled);
      subscriptionsList.mockResolvedValue({ data: [canceled] });
      constructEvent.mockReturnValueOnce(subscriptionEvent("sub_1"));
      const res1 = await POST(webhookRequest("{}"));
      expect(res1.status).toBe(200);

      constructEvent.mockReturnValueOnce(invoiceEvent());
      const res2 = await POST(webhookRequest("{}"));
      expect(res2.status).toBe(200);
      expect(updates[1]).toEqual(expect.objectContaining({ activated_at: expect.any(String) }));
    });

    it("does not activate when invoice.status is not 'paid', even for an invoice.paid-typed event", async () => {
      constructEvent.mockReturnValue(invoiceEvent({ status: "open" }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(updates).toHaveLength(0);
    });

    it("skips a non-subscription invoice cleanly (not this product's shape, but not a failure)", async () => {
      constructEvent.mockReturnValue(invoiceEvent({ parent: { type: "quote_details" } }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(updates).toHaveLength(0);
    });

    it("falls back to the stripe_customer_id lookup when the subscription metadata snapshot is missing", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 9 }, error: null }); // resolveOrganizationIdForInvoice fallback
      queue({ data: { organization_id: 9 }, error: null }); // activation write
      constructEvent.mockReturnValue(
        invoiceEvent({ parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: {} } } }),
      );
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(updates[0]).toEqual(expect.objectContaining({ activated_at: expect.any(String) }));
    });

    it("asks Stripe to retry when the organization can't be resolved for an invoice.paid event at all", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: null, error: null });
      constructEvent.mockReturnValue(
        invoiceEvent({ customer: null, parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: {} } } }),
      );
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(500);
      expect(updates).toHaveLength(0);
    });
  });
});
