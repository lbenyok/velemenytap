import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), select: vi.fn(), from: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }) }));
import { getPlatformAdmin } from "./access";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
});
describe("platform administrator identity", () => {
  it("rejects anonymous and failed Auth lookups before querying roles", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });
    expect(await getPlatformAdmin()).toBeNull(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("does not accept unverified email or user-editable metadata as authority", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "attacker", email_confirmed_at: null, user_metadata: { platform_admin: true } } } });
    expect(await getPlatformAdmin()).toBeNull(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("requires a fresh UID membership even for an organization owner", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "owner", email_confirmed_at: "today", user_metadata: { role: "owner", platform_admin: true } } } });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPlatformAdmin()).toBeNull(); expect(mocks.eq).toHaveBeenCalledWith("user_id", "owner");
  });
  it("accepts only the server-managed membership and fails closed on database failure", async () => {
    const user = { id: "platform-owner", email_confirmed_at: "today" };
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.maybeSingle.mockResolvedValue({ data: { user_id: user.id }, error: null });
    expect(await getPlatformAdmin()).toEqual(user);
    mocks.maybeSingle.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(getPlatformAdmin()).rejects.toThrow();
  });
});
