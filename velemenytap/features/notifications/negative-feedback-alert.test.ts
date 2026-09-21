import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), single: vi.fn(), members: vi.fn(), user: vi.fn(), send: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("resend", () => ({ Resend: class { emails = { send: mocks.send }; } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  rpc: mocks.rpc, from: mocks.from, auth: { admin: { getUserById: mocks.user } },
}) }));

const feedback = { organizationId: 1, nfcCardId: 2, organizationName: "Test", locationName: "Counter", cardName: null, rating: 2, feedbackText: "<script>private</script>" };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv("RESEND_API_KEY", "unit-test-only");
  vi.stubEnv("RESEND_FROM_EMAIL", "alerts@example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "claim_negative_alert_send" ? 7 : null, error: null }));
  mocks.from.mockImplementation((table: string) => table === "organizations"
    ? { select: () => ({ eq: () => ({ single: mocks.single }) }) }
    : { select: () => ({ eq: () => ({ in: mocks.members }) }) });
  mocks.single.mockResolvedValue({ data: { notification_email: "selected@example.com" }, error: null });
  mocks.members.mockResolvedValue({ data: [{ user_id: "member" }], error: null });
  mocks.user.mockResolvedValue({ data: { user: { email: "member@example.com", email_confirmed_at: "2026-09-01" } }, error: null });
  mocks.send.mockResolvedValue({ data: { id: "sent" }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function send() { return (await import("./negative-feedback-alert")).sendNegativeFeedbackAlert(feedback); }

it("does not fall back to members when notification settings cannot be read", async () => {
  mocks.single.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  await send();
  expect(mocks.members).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenLastCalledWith("finalize_negative_alert_send", { p_log_id: 7, p_delivered: false });
});
it("sends only to the verified override and escapes customer content", async () => {
  await send();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0][0]).toMatchObject({ to: ["selected@example.com"], from: "VéleményTap <alerts@example.com>" });
  expect(mocks.send.mock.calls[0][0].html).toContain("&lt;script&gt;");
  expect(mocks.members).not.toHaveBeenCalled();
});
it("uses confirmed membership recipients only when no override is configured", async () => {
  mocks.single.mockResolvedValue({ data: { notification_email: null }, error: null });
  await send();
  expect(mocks.send.mock.calls[0][0].to).toEqual(["member@example.com"]);
});
it("never delivers private feedback to an unconfirmed member address", async () => {
  mocks.single.mockResolvedValue({ data: { notification_email: null }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { email: "unconfirmed@example.com", email_confirmed_at: null } } });
  await send();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("does not send if the membership query fails", async () => {
  mocks.single.mockResolvedValue({ data: { notification_email: null }, error: null });
  mocks.members.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  await send();
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each([false, true])("finalization transport errors never escape; delivered=%s", async (delivered) => {
  mocks.send.mockResolvedValue({ error: delivered ? null : { name: "failure", message: "not accepted" } });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "finalize_negative_alert_send") throw new Error("network unavailable");
    return { data: 7, error: null };
  });
  await expect(send()).resolves.toBeUndefined();
  expect(mocks.rpc).toHaveBeenLastCalledWith("finalize_negative_alert_send", { p_log_id: 7, p_delivered: delivered });
});
