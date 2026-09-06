import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// lib/stripe.ts and lib/supabase/admin.ts both `import "server-only"`,
// which throws outside a real Next.js server build -- stub it out so this
// route (server-only by nature: it's a webhook) can be unit tested at all.
vi.mock("server-only", () => ({}));

const constructEvent = vi.fn();
vi.mock("stripe", () => ({
  // A real class, not a vi.fn() returning an object literal -- `new` on a
  // mocked arrow-function implementation isn't a valid constructor call
  // (see e2e/support/db-connection.test.ts for the same pattern with pg).
  default: class {
    webhooks = { constructEvent };
  },
}));

const insert = vi.fn();
const update = vi.fn();
const updateEq = vi.fn();
const updateOr = vi.fn();
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
      // (.update().eq().or().select().maybeSingle()) or the select-chain
      // (.select().eq().maybeSingle()), distinguished by which method is
      // called first.
      return {
        update: (payload: unknown) => {
          update(payload);
          return {
            eq: (col: string, val: unknown) => {
              updateEq(col, val);
              return {
                or: (filter: string) => {
                  updateOr(filter);
                  return { select: () => ({ maybeSingle: updateMaybeSingle }) };
                },
              };
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

const EVENT_CREATED = 1893456000;

function subscriptionEvent(
  subscriptionOverrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
) {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    created: EVENT_CREATED,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: { organization_id: "42" },
        items: { data: [{ current_period_end: 1893456000 }] },
        ...subscriptionOverrides,
      },
    },
    ...eventOverrides,
  };
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    vi.resetModules();
    constructEvent.mockReset();
    insert.mockReset();
    update.mockReset();
    updateEq.mockReset();
    updateOr.mockReset();
    updateMaybeSingle.mockReset();
    selectEq.mockReset();
    selectMaybeSingle.mockReset();
    insert.mockResolvedValue({ error: null });
    // Default: the update matches exactly one row -- a normal, in-order,
    // first-time application of the event.
    updateMaybeSingle.mockResolvedValue({ data: { organization_id: 42 }, error: null });
    selectMaybeSingle.mockResolvedValue({ data: { organization_id: 42 }, error: null });
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

  it("processes a genuine, first-time event: applies the update, then records the event", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateEq).toHaveBeenCalledWith("organization_id", 42);
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
  });

  it("guards the update against out-of-order delivery using the event's own created timestamp, not this server's clock", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({}, { created: 1700000000 }));
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    const expectedIso = new Date(1700000000 * 1000).toISOString();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ last_synced_event_created_at: expectedIso }));
    expect(updateOr).toHaveBeenCalledWith(expect.stringContaining(expectedIso));
    expect(updateOr).toHaveBeenCalledWith(expect.stringContaining("is.null"));
  });

  /**
   * Round <billing fix> finding B: the event's effect (the update) is now
   * applied BEFORE it's recorded as done in stripe_webhook_events --
   * specifically so a process crash or transient failure between the two
   * steps can never look like a lost update: the previous design recorded
   * the event id FIRST, so a crash after that point permanently marked a
   * never-applied event as done. A genuine duplicate delivery now
   * re-applies this same idempotent update (harmless) instead of skipping
   * it, and is still reported as a duplicate once it hits the insert's
   * unique-violation.
   */
  it("reprocesses a duplicate delivery of the same event id idempotently, still reporting it as a duplicate", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
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

  it("falls back to looking up the organization by stripe_customer_id when metadata is missing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({ metadata: {} }));
    selectMaybeSingle.mockResolvedValue({ data: { organization_id: 7 }, error: null });
    updateMaybeSingle.mockResolvedValue({ data: { organization_id: 7 }, error: null });
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    expect(updateEq).toHaveBeenCalledWith("organization_id", 7);
  });

  it("asks Stripe to retry when the organization can't be resolved at all, rather than silently swallowing the event", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({ metadata: {} }));
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updateEq).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  /**
   * The direct test for Finding B's out-of-order-delivery protection: the
   * update's own WHERE clause (last_synced_event_created_at is null OR
   * older than this event) is what makes a stale event match zero rows --
   * simulated here by having the update resolve to "no row matched" while
   * the row genuinely exists (the follow-up existence check finds it).
   * This must be treated as a successful no-op, not a failure: the event
   * is still recorded as processed.
   */
  it("skips an out-of-order/stale event (older than one already applied) without treating it as a failure", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    selectMaybeSingle.mockResolvedValue({ data: { organization_id: 42 }, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
  });

  /**
   * The other reason an update can match zero rows: the organization has
   * no organization_billing row at all (Finding A's exact scenario) --
   * this is a real data-integrity problem and must ask Stripe to retry,
   * never be silently indistinguishable from a correctly-skipped stale
   * event.
   */
  it("asks Stripe to retry when organization_billing has no row at all for a resolved organization, never silently treated as success", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
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

  it("maps a subscription status Stripe added after this integration to 'incomplete' instead of failing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({ status: "some_future_status" }));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "incomplete" }));
  });

  it("ignores event types it doesn't need to act on, but still acknowledges them", async () => {
    constructEvent.mockReturnValue({
      id: "evt_2",
      type: "invoice.created",
      created: EVENT_CREATED,
      data: { object: {} },
    });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateEq).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({ id: "evt_2" });
  });
});
