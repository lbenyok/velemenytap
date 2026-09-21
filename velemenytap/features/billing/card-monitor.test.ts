import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), updates: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: m.rpc, from: m.from }) }));
vi.mock("resend", () => ({ Resend: class { emails = { send: m.send }; } }));
import { sendBillingOwnerNotices } from "./card-monitor";
const notice = { id: 3, recipient: "owner@example.invalid", sender: "stored@example.invalid", message: "Immutable message", lease_owner: "token" };
beforeEach(() => {
  vi.clearAllMocks(); m.updates.length = 0;
  process.env.RESEND_API_KEY = "test"; process.env.RESEND_FROM_EMAIL = "new@example.invalid";
  m.from.mockImplementation((table: string) => {
    const q = { select: vi.fn(() => q), eq: vi.fn(() => q), update: vi.fn((value: unknown) => { m.updates.push(value); return q; }),
      single: async () => ({ data: { enabled: true }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "billing_owner_notices" ? [{ id: 3 }] : null, count: 0, error: null }).then(resolve) };
    return q;
  });
  m.rpc.mockResolvedValue({ data: [], error: null });
  m.send.mockResolvedValue({ data: { id: "provider-id" }, error: null });
});
it("uses the persisted recipient, sender, content and stable retry key", async () => {
  m.rpc.mockResolvedValueOnce({ data: [notice], error: null });
  expect(await sendBillingOwnerNotices()).toEqual({ sent: 1, errors: 0 });
  expect(m.send).toHaveBeenCalledWith({ from: "VéleményTap <stored@example.invalid>", to: [notice.recipient], text: notice.message, subject: expect.any(String) }, { idempotencyKey: "billing-owner-notice/3" });
  expect(m.updates[0]).toMatchObject({ provider_id: "provider-id", sent_at: expect.any(String) });
});
it("does not mark provider rejection as sent", async () => {
  m.rpc.mockResolvedValueOnce({ data: [notice], error: null });
  m.send.mockResolvedValue({ error: { message: "rate limit" } });
  expect(await sendBillingOwnerNotices()).toEqual({ sent: 0, errors: 1 });
  expect(m.updates).toHaveLength(1);
  expect(m.updates[0]).not.toHaveProperty("sent_at");
});
it("does not consume a notification claim when credentials are missing", async () => {
  delete process.env.RESEND_API_KEY;
  expect(await sendBillingOwnerNotices()).toEqual({ sent: 0, errors: 1 });
  expect(m.rpc).not.toHaveBeenCalled();
});
