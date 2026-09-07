import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// lib/stripe.ts and lib/supabase/admin.ts both `import "server-only"`,
// which throws outside a real Next.js server build -- stub it out so this
// route (server-only by nature: it's a webhook) can be unit tested at all.
vi.mock("server-only", () => ({}));

const constructEvent = vi.fn();
const subscriptionsRetrieve = vi.fn();
vi.mock("stripe", () => ({
  // A real class, not a vi.fn() returning an object literal -- `new` on a
  // mocked arrow-function implementation isn't a valid constructor call
  // (see e2e/support/db-connection.test.ts for the same pattern with pg).
  default: class {
    webhooks = { constructEvent };
    subscriptions = { retrieve: subscriptionsRetrieve };
  },
}));

const insert = vi.fn();
const update = vi.fn();
const updateEq = vi.fn();
const updateMaybeSingle = vi.fn();
const selectEq = vi.fn();
const selectMaybeSingle = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "stripe_webhook_events") {
        return { insert };
      }
      // organization_billing: either the update-chain
      // (.update().eq().select().maybeSingle()) or the select-chain
      // (.select().eq().maybeSingle()), distinguished by which method is
      // called first. syncSubscription now issues a select-chain call
      // (reading activated_at) before its own update-chain call, and
      // resolveOrganizationId's fallback path issues an EARLIER
      // select-chain call of its own when metadata is missing -- tests
      // exercising that path queue two selectMaybeSingle values.
      return {
        update: (payload: unknown) => {
          update(payload);
          return {
            eq: (col: string, val: unknown) => {
              updateEq(col, val);
              return { select: () => ({ maybeSingle: updateMaybeSingle }) };
            },
          };
        },
        select: () => ({
          eq: (col: string, val: unknown) => {
            selectEq(col, val);
            return { maybeSingle: selectMaybeSingle };
          },
        }),
      };
    },
  }),
}));

function webhookRequest(body: string, signature: string | null = "t=1,v1=fake") {
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : {},
  });
}

/**
 * The event body only ever needs to carry an `id` (used to look up the
 * canonical state) -- everything else the handler writes now comes from
 * `subscriptionsRetrieve`'s own mocked return value, per this round's
 * canonical-current-state-retrieval fix. `eventOverrides` lets a test
 * still shape the outer event's own id/type when needed.
 */
function subscriptionEvent(subscriptionId = "sub_1", eventOverrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    data: { object: { id: subscriptionId } },
    ...eventOverrides,
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
    ...overrides,
  };
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    vi.resetModules();
    constructEvent.mockReset();
    subscriptionsRetrieve.mockReset();
    insert.mockReset();
    update.mockReset();
    updateEq.mockReset();
    updateMaybeSingle.mockReset();
    selectEq.mockReset();
    selectMaybeSingle.mockReset();
    insert.mockResolvedValue({ error: null });
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
    // Default: the organization's row already exists and has never
    // activated -- the common case for most tests below (metadata-based
    // resolution needs no select() call of its own, so this is the ONE
    // selectMaybeSingle call syncSubscription's own activated_at pre-read
    // makes).
    selectMaybeSingle.mockResolvedValue({ data: { activated_at: null }, error: null });
    updateMaybeSingle.mockResolvedValue({ data: { organization_id: 42 }, error: null });
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

  it("processes a genuine, first-time event: retrieves canonical state, applies it, then records the event", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_1");
    expect(updateEq).toHaveBeenCalledWith("organization_id", 42);
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
  });

  it("never trusts the event's own embedded object -- only its id is read before the canonical retrieve() call", async () => {
    // A deliberately wrong/stale embedded subscription -- if this were
    // ever used instead of the retrieve() result, the write below would
    // reflect "canceled", not "active".
    constructEvent.mockReturnValue({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "canceled", customer: "cus_evil" } },
    });
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "active" }));
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "active", stripe_customer_id: "cus_1" }));
  });

  /**
   * The direct reproduction for this round's finding: two distinct
   * subscription events sharing Stripe's own one-second `created`
   * resolution used to make the SECOND one look "not newer" under a
   * strict `<` timestamp comparison, silently dropping its state. With
   * canonical retrieval, there is no timestamp comparison left at all --
   * each event just triggers a fresh retrieve(), and whichever retrieve()
   * result is fetched (here, simulating the later of the two same-second
   * events) is what gets written, regardless of arrival order.
   */
  it("never loses the later state between two events at the identical one-second timestamp", async () => {
    const { POST } = await import("./route");

    // Event 1: subscription is "active" as of this same-second retrieve.
    constructEvent.mockReturnValueOnce(subscriptionEvent("sub_1", { id: "evt_1", created: 1893456000 }));
    subscriptionsRetrieve.mockResolvedValueOnce(canonicalSubscription({ status: "active" }));
    const res1 = await POST(webhookRequest("{}"));
    expect(res1.status).toBe(200);
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "active" }));

    // Event 2: a genuinely later state change (past_due), delivered with
    // the SAME `created` second as event 1 -- Stripe's own timestamp
    // resolution, not a test artifact. The old strict-`<` guard would
    // have compared this against event 1's already-recorded timestamp,
    // found them equal (not less-than), and silently skipped this write.
    // (activated_at was already set to non-null by event 1's own write in
    // the real database -- selectMaybeSingle's persistent default here
    // still reports null, which is fine: this test is specifically about
    // `status`, not activated_at, and a null activated_at doesn't block
    // the status write either way.)
    constructEvent.mockReturnValueOnce(subscriptionEvent("sub_1", { id: "evt_2", created: 1893456000 }));
    subscriptionsRetrieve.mockResolvedValueOnce(canonicalSubscription({ status: "past_due" }));
    const res2 = await POST(webhookRequest("{}"));

    expect(res2.status).toBe(200);
    // The later state must have actually been written -- not skipped.
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "past_due" }));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("reprocesses a duplicate delivery of the same event id idempotently, still reporting it as a duplicate", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
    // Reprocessing (re-fetching canonical state and re-applying it) still
    // happens for a duplicate -- harmless, since the write is idempotent.
    expect(subscriptionsRetrieve).toHaveBeenCalled();
    expect(updateEq).toHaveBeenCalledWith("organization_id", 42);
  });

  it("asks Stripe to retry (5xx) when recording the event id fails for a reason other than a duplicate, after the update already succeeded", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "OTHER", message: "connection reset" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updateEq).toHaveBeenCalled();
  });

  it("asks Stripe to retry when the canonical retrieve() call itself fails", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockRejectedValue(new Error("Stripe is down"));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("falls back to looking up the organization by stripe_customer_id when metadata is missing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    // First selectMaybeSingle call: resolveOrganizationId's own customer-id
    // lookup. Second (falling through to the persistent beforeEach
    // default): syncSubscription's activated_at pre-read.
    selectMaybeSingle.mockResolvedValueOnce({ data: { organization_id: 7 }, error: null });
    updateMaybeSingle.mockResolvedValue({ data: { organization_id: 7 }, error: null });
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    expect(updateEq).toHaveBeenCalledWith("organization_id", 7);
  });

  it("asks Stripe to retry when the organization can't be resolved at all, rather than silently swallowing the event", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updateEq).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when organization_billing has no row at all for a resolved organization, never silently treated as success", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    // The activated_at pre-read is what now detects a missing row.
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the activated_at pre-read itself errors", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    selectMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the billing-state update itself errors, and never records the event as processed", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    updateMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the final update unexpectedly matches zero rows (the row vanished between read and write)", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("maps a subscription status Stripe added after this integration to 'incomplete' instead of failing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "some_future_status" }));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "incomplete" }));
  });

  it("ignores event types it doesn't need to act on, but still acknowledges them, without ever calling retrieve()", async () => {
    constructEvent.mockReturnValue({
      id: "evt_2",
      type: "invoice.created",
      data: { object: {} },
    });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(updateEq).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({ id: "evt_2" });
  });

  /**
   * Found during an independent review: isBillingActive() needs a
   * one-time "has this organization ever actually paid" signal, separate
   * from the subscription's own current status, so that grandfathering
   * survives a failed first payment (features/billing/status.ts's own
   * comment has the full incident). activated_at is that signal, and this
   * is where it gets set -- these tests cover the write side directly.
   */
  describe("activated_at", () => {
    it("sets activated_at on the first transition to 'active' for an organization that has never activated before", async () => {
      constructEvent.mockReturnValue(subscriptionEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "active" }));
      selectMaybeSingle.mockResolvedValue({ data: { activated_at: null }, error: null });
      const { POST } = await import("./route");
      await POST(webhookRequest("{}"));
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ activated_at: expect.any(String) }));
    });

    it("never overwrites an already-set activated_at -- a later cancellation or reactivation leaves the original value untouched", async () => {
      constructEvent.mockReturnValue(subscriptionEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "active" }));
      selectMaybeSingle.mockResolvedValue({ data: { activated_at: "2026-01-01T00:00:00.000Z" }, error: null });
      const { POST } = await import("./route");
      await POST(webhookRequest("{}"));
      // Omitted from the payload entirely (not set to null and not set to
      // a fresh value) -- PostgREST only touches columns present in the
      // update payload, so omitting it is what leaves the stored value
      // alone.
      const [payload] = update.mock.calls[0] as [Record<string, unknown>];
      expect(payload).not.toHaveProperty("activated_at");
    });

    it("does not set activated_at for a non-'active' status, even for an organization that has never activated", async () => {
      constructEvent.mockReturnValue(subscriptionEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ status: "incomplete" }));
      selectMaybeSingle.mockResolvedValue({ data: { activated_at: null }, error: null });
      const { POST } = await import("./route");
      await POST(webhookRequest("{}"));
      const [payload] = update.mock.calls[0] as [Record<string, unknown>];
      expect(payload).not.toHaveProperty("activated_at");
    });
  });
});
