import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), rpc: vi.fn(), refresh: vi.fn(), reconcile: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./access", () => ({ getPlatformAdmin: m.access }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("@/features/billing/reconcile", () => ({ reconcileOrganizationBilling: m.reconcile }));
import { checkBillingNowAction, saveBillingAlertSettingsAction, saveBillingCardModeAction } from "./billing-actions";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [k,v] of Object.entries({ organizationId: "42", mode: "automatic", graceDays: "3", revision: "0", actorId: "forged", ...values })) data.set(k,v);
  return data;
}
beforeEach(() => { vi.clearAllMocks(); m.admin.mockReturnValue({ rpc: m.rpc }); });
it("denies all billing admin actions before privileged reads or writes", async () => {
  m.access.mockResolvedValue(null);
  for (const action of [checkBillingNowAction, saveBillingAlertSettingsAction, saveBillingCardModeAction])
    expect((await action({}, form())).error).toBeTruthy();
  expect(m.admin).not.toHaveBeenCalled();
});
it("uses the verified actor and passes a revision for stale-form protection", async () => {
  m.access.mockResolvedValue({ id: "real-owner" }); m.rpc.mockResolvedValue({ error: null });
  expect((await saveBillingCardModeAction({}, form())).success).toBeTruthy();
  expect(m.rpc).toHaveBeenCalledWith("set_billing_card_mode", { p_actor_id: "real-owner", p_organization_id: 42, p_mode: "automatic", p_grace_days: 3, p_expected_revision: 0 });
});
it("rejects invalid mode, organization, grace period and revision", async () => {
  m.access.mockResolvedValue({ id: "real-owner" });
  for (const values of ([{ mode: "auto" }, { graceDays: "-1" }, { graceDays: "31" }, { organizationId: "-1" }, { revision: "-1" }] as Record<string, string>[]))
    expect((await saveBillingCardModeAction({}, form(values))).error).toBeTruthy();
  expect(m.admin).not.toHaveBeenCalled();
});
it("cannot direct financial alerts to an address supplied by the browser", async () => {
  m.access.mockResolvedValue({ id: "owner", email: "verified@example.invalid" });
  const eq = vi.fn().mockResolvedValue({ error: null }); const update = vi.fn(() => ({ eq }));
  m.admin.mockReturnValue({ from: () => ({ update }) });
  expect((await saveBillingAlertSettingsAction({}, form({ enabled: "on", email: "attacker@example.invalid" }))).success).toBeTruthy();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ recipient: "verified@example.invalid", updated_by: "owner", enabled: true }));
});
it("does not evaluate stale billing when Stripe refresh failed or was deferred", async () => {
  m.access.mockResolvedValue({ id: "owner" });
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { stripe_customer_id: "cus_1" }, error: null }) };
  m.admin.mockReturnValue({ from: () => query, rpc: m.rpc });
  for (const outcome of ["error", "deferred"]) {
    m.reconcile.mockResolvedValue({ outcome });
    expect((await checkBillingNowAction({}, form())).error).toBeTruthy();
  }
  expect(m.rpc).not.toHaveBeenCalled();
});

