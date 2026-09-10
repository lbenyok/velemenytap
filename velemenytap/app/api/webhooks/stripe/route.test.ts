import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Fourth independent review: app/api/webhooks/stripe/route.ts now
 * delegates all actual reconciliation to features/billing/reconcile.ts
 * (the shared service, Finding 5) -- this file's own job narrowed to
 * signature/environment verification, organization resolution, and the
 * customer-identity check (Finding 11) before ever calling that service.
 * reconcile.ts's own concurrency/locking behavior is proven separately,
 * against the real isolated Supabase project
 * (e2e/billing-reconciliation-lease.spec.ts) -- mocking it here would
 * only prove this route calls it, never that the lease itself is
 * correct, which is exactly the "not acceptable as sole proof of
 * database locking" the review's own instructions call out.
 */

vi.mock("server-only", () => ({}));

const constructEvent = vi.fn();
const subscriptionsRetrieve = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent };
    subscriptions = { retrieve: subscriptionsRetrieve };
  },
}));

const insert = vi.fn();

const maybeSingleQueue: { data: unknown; error: unknown }[] = [];
function queue(...results: { data: unknown; error: unknown }[]) {
  maybeSingleQueue.push(...results);
}
const DEFAULT_RESULT = { data: null, error: null };

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
      return { select: () => chain() };
    },
  }),
}));

const reconcileOrganizationBilling = vi.fn();
const activateOrganizationBilling = vi.fn();
const recordAnomaly = vi.fn();
vi.mock("@/features/billing/reconcile", () => ({
  reconcileOrganizationBilling: (...args: unknown[]) => reconcileOrganizationBilling(...args),
  activateOrganizationBilling: (...args: unknown[]) => activateOrganizationBilling(...args),
  customerIdMatches: (persisted: string | null, observed: string) => persisted === null || persisted === observed,
  subscriptionPriceId: (subscription: { items: { data: { price: { id: string } | string }[] } }) => {
    const price = subscription.items.data[0]?.price;
    return typeof price === "string" ? price : (price?.id ?? null);
  },
  recordAnomaly: (...args: unknown[]) => recordAnomaly(...args),
}));

const approvedPriceIds = vi.fn(() => new Set(["price_monthly", "price_yearly"]));
vi.mock("@/features/billing/stripe-config", () => ({
  resolveExpectedLivemode: vi.fn(() => ({ expected: false, isLocalDev: false })),
  approvedPriceIds: () => approvedPriceIds(),
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
        created: 1789000000,
        status_transitions: { paid_at: 1789000123 },
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
    metadata: { organization_id: "42" },
    items: { data: [{ price: { id: "price_monthly" } }] },
    ...overrides,
  };
}

let resolveExpectedLivemodeMock: ReturnType<typeof vi.fn>;

describe("POST /api/webhooks/stripe", () => {
  beforeEach(async () => {
    vi.resetModules();
    constructEvent.mockReset();
    subscriptionsRetrieve.mockReset();
    insert.mockReset();
    reconcileOrganizationBilling.mockReset();
    activateOrganizationBilling.mockReset();
    recordAnomaly.mockReset();
    maybeSingleQueue.length = 0;

    insert.mockResolvedValue({ error: null });
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "sub_1", status: "active" });
    activateOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "", status: "active" });
    recordAnomaly.mockResolvedValue(undefined);
    // Default: no persisted stripe_customer_id yet.
    queue({ data: { stripe_customer_id: null }, error: null });

    const stripeConfigModule = await import("@/features/billing/stripe-config");
    resolveExpectedLivemodeMock = vi.mocked(stripeConfigModule.resolveExpectedLivemode);
    resolveExpectedLivemodeMock.mockReturnValue({ expected: false, isLocalDev: false });
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

  describe("Finding 6: fail-closed environment checks", () => {
    it("rejects when resolveExpectedLivemode throws (deployed runtime, unrecognized APP_ENV)", async () => {
      resolveExpectedLivemodeMock.mockImplementation(() => {
        throw new Error("APP_ENV is unset in a deployed runtime");
      });
      constructEvent.mockReturnValue(subscriptionEvent());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(400);
      expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    });

    it("rejects a live-mode event when the runtime expects test-mode", async () => {
      resolveExpectedLivemodeMock.mockReturnValue({ expected: false, isLocalDev: false });
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(400);
      expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    });

    it("accepts a live-mode event when the runtime expects live-mode", async () => {
      resolveExpectedLivemodeMock.mockReturnValue({ expected: true, isLocalDev: false });
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
    });

    it("does not gate on livemode at all when this is genuine local development", async () => {
      resolveExpectedLivemodeMock.mockReturnValue({ expected: null, isLocalDev: true });
      constructEvent.mockReturnValue(subscriptionEvent("sub_1", { livemode: true }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
    });
  });

  it("resolves the organization, verifies the customer matches, then delegates to the shared reconciliation service", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(reconcileOrganizationBilling).toHaveBeenCalledWith(42, "cus_1");
    expect(insert).toHaveBeenCalledWith({ id: "evt_1" });
  });

  it("Finding 11: refuses to sync (asks Stripe to retry) when the subscription's Stripe Customer does not match the organization's already-persisted customer -- quarantined, never rebinding the organization", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { stripe_customer_id: "cus_DIFFERENT" }, error: null });
    constructEvent.mockReturnValue(subscriptionEvent());
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
    expect(recordAnomaly).toHaveBeenCalledWith(expect.anything(), 42, "customer_mismatch", expect.anything());
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the shared service reports an error", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "error", message: "boom" });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the shared service defers (lease contention) -- durable dirty-marking is the real guarantee, this is just a fast-path retry", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "deferred" });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the canonical retrieve() call itself fails", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockRejectedValue(new Error("Stripe is down"));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("falls back to looking up the organization by stripe_customer_id when metadata is missing", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: { organization_id: 7 }, error: null }); // resolveOrganizationId fallback
    queue({ data: { stripe_customer_id: null }, error: null }); // mismatch-check read
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(reconcileOrganizationBilling).toHaveBeenCalledWith(7, "cus_1");
  });

  it("asks Stripe to retry when the organization can't be resolved at all", async () => {
    maybeSingleQueue.length = 0;
    queue({ data: null, error: null });
    constructEvent.mockReturnValue(subscriptionEvent());
    subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ metadata: {} }));
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(500);
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
  });

  it("reprocesses a duplicate delivery of the same event id idempotently, still reporting it as a duplicate", async () => {
    constructEvent.mockReturnValue(subscriptionEvent());
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
  });

  it("ignores event types it doesn't need to act on, but still acknowledges them", async () => {
    constructEvent.mockReturnValue({ id: "evt_2", type: "customer.updated", livemode: false, data: { object: {} } });
    const { POST } = await import("./route");
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({ id: "evt_2" });
  });

  describe("Finding 5/11: invoice.paid activation", () => {
    it("validates customer match and approved price, then delegates to the shared activation service", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { stripe_customer_id: "cus_1" }, error: null }); // mismatch-check read
      constructEvent.mockReturnValue(invoiceEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      // R10-01: the verified payment travels WITH the activation. Everything
      // this handler checked -- invoice paid, customer matched, approved price
      // -- is what makes it evidence, and recording it is what stops a later
      // reader re-deriving "has this org ever paid?" from a live Stripe status.
      expect(activateOrganizationBilling).toHaveBeenCalledWith(42, {
        invoiceId: "in_1",
        subscriptionId: "sub_1",
        priceId: "price_monthly",
        paidAt: new Date(1789000123 * 1000).toISOString(),
      });
    });

    it("refuses to activate when the invoice customer does not match the organization's persisted customer", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { stripe_customer_id: "cus_DIFFERENT" }, error: null });
      constructEvent.mockReturnValue(invoiceEvent());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(500);
      expect(activateOrganizationBilling).not.toHaveBeenCalled();
      expect(recordAnomaly).toHaveBeenCalledWith(expect.anything(), 42, "customer_mismatch", expect.anything());
    });

    it("Finding 11: a mismatched invoice (unapproved subscription price) never sets activated_at", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { stripe_customer_id: "cus_1" }, error: null });
      constructEvent.mockReturnValue(invoiceEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription({ items: { data: [{ price: { id: "price_UNAPPROVED" } }] } }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200); // not retried -- this is a data fact, not transient
      expect(activateOrganizationBilling).not.toHaveBeenCalled();
      expect(recordAnomaly).toHaveBeenCalledWith(expect.anything(), 42, "unapproved_subscription", expect.anything());
    });

    it("does not activate when invoice.status is not 'paid'", async () => {
      constructEvent.mockReturnValue(invoiceEvent({ status: "open" }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(activateOrganizationBilling).not.toHaveBeenCalled();
    });

    it("skips a non-subscription invoice cleanly", async () => {
      constructEvent.mockReturnValue(invoiceEvent({ parent: { type: "quote_details" } }));
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(activateOrganizationBilling).not.toHaveBeenCalled();
    });

    it("falls back to the stripe_customer_id lookup when the subscription metadata snapshot is missing", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { organization_id: 9 }, error: null }); // resolveOrganizationIdForInvoice fallback
      queue({ data: { stripe_customer_id: "cus_1" }, error: null }); // mismatch-check read
      constructEvent.mockReturnValue(
        invoiceEvent({ parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: {} } } }),
      );
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(200);
      expect(activateOrganizationBilling).toHaveBeenCalledWith(9, expect.objectContaining({ invoiceId: "in_1" }));
    });

    /**
     * R10-03: activation used to be able to return `deferred` (it competed for
     * the reconciliation lease), and a deferred activation whose invoice was
     * never redelivered could never be completed. It is now a single atomic
     * write with no lease, so the only non-success is a genuine failure -- and
     * that must still ask Stripe to redeliver, because the payment fact would
     * otherwise be lost.
     */
    it("asks Stripe to retry when the activation write fails", async () => {
      maybeSingleQueue.length = 0;
      queue({ data: { stripe_customer_id: "cus_1" }, error: null });
      constructEvent.mockReturnValue(invoiceEvent());
      subscriptionsRetrieve.mockResolvedValue(canonicalSubscription());
      activateOrganizationBilling.mockResolvedValue({ outcome: "error", message: "database unavailable" });
      const { POST } = await import("./route");
      const res = await POST(webhookRequest("{}"));
      expect(res.status).toBe(500);
    });
  });
});
