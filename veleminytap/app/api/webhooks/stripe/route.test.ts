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
const selectMaybeSingle = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "stripe_webhook_events") {
        return { insert };
      }
      // organization_billing: either the update-chain or the
      // select-chain, distinguished by which method is called next.
      return {
        update: (payload: unknown) => {
          update(payload);
          return { eq: updateEq };
        },
        select: () => ({ eq: () => ({ maybeSingle: selectMaybeSingle }) }),
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

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: { organization_id: "42" },
        items: { data: [{ current_period_end: 1893456000 }] },
        ...overrides,
      },
    },
  };
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    vi.resetModules();
    constructEvent.mockReset();
    insert.mockReset();
    update.mockReset();
    updateEq.mockReset();
    selectMaybeSingle.mockReset();
    insert.mockResolvedValue({ error: null });
    updateEq.mockResolvedValue({ error: null });
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

  it("processes a genuine, first-time event and updates the org's billing row", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
    expect(updateEq).toHaveBeenCalledWith("organization_id", 42);
  });

  it("does not reapply a duplicate delivery of the same event id", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    // Same shape a real Postgres unique_violation comes back as through
    // supabase-js's PostgrestError.
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
    // The whole point of the idempotency gate: never reaches the update.
    expect(updateEq).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry (5xx) when recording the event id fails for a reason other than a duplicate", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "OTHER", message: "connection reset" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(updateEq).not.toHaveBeenCalled();
  });

  it("falls back to looking up the organization by stripe_customer_id when metadata is missing", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({ metadata: {} }));
    selectMaybeSingle.mockResolvedValue({ data: { organization_id: 7 } });
    const { POST } = await import("./route");
    await POST(webhookRequest("{}"));
    expect(updateEq).toHaveBeenCalledWith("organization_id", 7);
  });

  it("silently no-ops (not a crash) when the organization can't be resolved at all", async () => {
    constructEvent.mockReturnValue(subscriptionEvent({ metadata: {} }));
    selectMaybeSingle.mockResolvedValue({ data: null });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateEq).not.toHaveBeenCalled();
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
      data: { object: {} },
    });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateEq).not.toHaveBeenCalled();
  });
});
