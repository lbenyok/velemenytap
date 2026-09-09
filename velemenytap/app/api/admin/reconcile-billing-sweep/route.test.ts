import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R9-06 (independent round-9 review). The sweep is the monitored backstop for
 * billing convergence, and the only signal its GitHub Actions workflow reads
 * is the HTTP status (`curl -fsS`). It used to return 200 unconditionally --
 * so a run in which Stripe was unreachable and every single reconciliation
 * returned `error` still left the job green.
 *
 * The durable dirty flags mean no work is lost in that case. But "no work is
 * lost" and "the operator has been told" are different guarantees, and only
 * the first one held.
 */

vi.mock("server-only", () => ({}));

const { reconcileOrganizationBilling, rpc } = vi.hoisted(() => ({
  reconcileOrganizationBilling: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/features/billing/reconcile", () => ({ reconcileOrganizationBilling }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { POST } from "./route";

const SECRET = "sweep-secret";

function request(auth: string | null = `Bearer ${SECRET}`) {
  return { headers: { get: (k: string) => (k === "authorization" ? auth : null) } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RECONCILE_SWEEP_SECRET = SECRET;
  rpc.mockResolvedValue({ data: [{ organization_id: 42, stripe_customer_id: "cus_1" }], error: null });
  reconcileOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "sub_1", status: "active" });
});

describe("POST /api/admin/reconcile-billing-sweep", () => {
  it("returns 200 when the sweep genuinely reconciled everything", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ swept: 1, errors: 0 });
  });

  it("R9-06: a run where every reconciliation ERRORED must not report success", async () => {
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "error", message: "Stripe unreachable" });

    const res = await POST(request());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ swept: 1, errors: 1 });
  });

  it("R9-06: lease contention is normal, not a failure -- `deferred` stays green", async () => {
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "deferred" });

    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ errors: 0 });
  });

  it("a partial failure is still a failure -- one error among several escalates", async () => {
    rpc.mockResolvedValue({
      data: [
        { organization_id: 1, stripe_customer_id: "cus_1" },
        { organization_id: 2, stripe_customer_id: "cus_2" },
      ],
      error: null,
    });
    reconcileOrganizationBilling
      .mockResolvedValueOnce({ outcome: "reconciled", subscriptionId: "sub_1", status: "active" })
      .mockResolvedValueOnce({ outcome: "error", message: "boom" });

    const res = await POST(request());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ swept: 2, errors: 1 });
  });

  it("still refuses an unauthenticated call, and reports 503 when unconfigured", async () => {
    expect((await POST(request("Bearer wrong"))).status).toBe(401);
    delete process.env.RECONCILE_SWEEP_SECRET;
    expect((await POST(request())).status).toBe(503);
  });
});
