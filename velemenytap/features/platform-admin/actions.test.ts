import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("./access", () => ({ getPlatformAdmin: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { setPlatformCardLockAction } from "./actions";
function request() { const data = new FormData(); for (const [key, value] of Object.entries({ cardId: "42", locked: "true", expected: "false", reason: "Lost card", actorId: "forged" })) data.set(key, value); return data; }
beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockReturnValue({ rpc: mocks.rpc }); });
it("denies crafted action calls before service-role access", async () => {
  mocks.access.mockResolvedValue(null);
  expect((await setPlatformCardLockAction({}, request())).error).toBeTruthy();
  expect(mocks.admin).not.toHaveBeenCalled();
});
it("derives actor from authenticated identity, never submitted identity", async () => {
  mocks.access.mockResolvedValue({ id: "real-owner" }); mocks.rpc.mockResolvedValue({ error: null });
  expect(await setPlatformCardLockAction({}, request())).toEqual({ success: true });
  expect(mocks.rpc).toHaveBeenCalledWith("set_platform_card_lock", { p_actor_id: "real-owner", p_card_id: 42, p_locked: true, p_expected_locked: false, p_reason: "Lost card" });
});
it("rejects invalid IDs, missing reasons and invalid booleans", async () => {
  mocks.access.mockResolvedValue({ id: "real-owner" });
  for (const [key, value] of [["cardId", "9007199254740992"], ["cardId", "-1"], ["reason", " "], ["locked", "yes"]]) {
    const data = request(); data.set(key, value);
    expect((await setPlatformCardLockAction({}, data)).error).toBeTruthy();
  }
  expect(mocks.admin).not.toHaveBeenCalled();
});
it("does not report success or revalidate when the atomic mutation fails", async () => {
  mocks.access.mockResolvedValue({ id: "real-owner" }); mocks.rpc.mockResolvedValue({ error: { code: "40001" } });
  expect((await setPlatformCardLockAction({}, request())).error).toBeTruthy();
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
