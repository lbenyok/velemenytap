import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentOrganization = vi.hoisted(() => vi.fn());
vi.mock("@/features/organizations/current", () => ({ getCurrentOrganization: mockGetCurrentOrganization }));

const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

const reconcileOrganizationBilling = vi.fn();
vi.mock("@/features/billing/reconcile", () => ({
  reconcileOrganizationBilling: (...args: unknown[]) => reconcileOrganizationBilling(...args),
}));

import { resyncOrganizationBillingAction } from "./admin-actions";

const OWNER_ORG = { id: 42, name: "Test Org", slug: "test-org", role: "owner" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentOrganization.mockResolvedValue(OWNER_ORG);
  maybeSingle.mockResolvedValue({ data: { stripe_customer_id: "cus_1" }, error: null });
  reconcileOrganizationBilling.mockResolvedValue({ outcome: "reconciled", subscriptionId: "sub_1", status: "active" });
});

describe("resyncOrganizationBillingAction", () => {
  it("fails when there is no current organization", async () => {
    mockGetCurrentOrganization.mockResolvedValue(null);
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("error");
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
  });

  it.each(["manager", "staff"] as const)("refuses role '%s'", async (role) => {
    mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("error");
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("allows role '%s' and calls the shared reconciliation service", async (role) => {
    mockGetCurrentOrganization.mockResolvedValue({ ...OWNER_ORG, role });
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("success");
    expect(reconcileOrganizationBilling).toHaveBeenCalledWith(42, "cus_1");
  });

  it("fails when the organization has no Stripe customer yet", async () => {
    maybeSingle.mockResolvedValue({ data: { stripe_customer_id: null }, error: null });
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("error");
    expect(reconcileOrganizationBilling).not.toHaveBeenCalled();
  });

  it("reports a friendly error, not a crash, when reconciliation is deferred", async () => {
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "deferred" });
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("error");
  });

  it("reports a friendly error when Stripe reports no subscriptions", async () => {
    reconcileOrganizationBilling.mockResolvedValue({ outcome: "no_subscriptions" });
    const result = await resyncOrganizationBillingAction();
    expect(result.status).toBe("error");
  });
});
