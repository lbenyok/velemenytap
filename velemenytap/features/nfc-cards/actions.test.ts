import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organization: vi.fn(), from: vi.fn(), update: vi.fn(), eq: vi.fn(),
  select: vi.fn(), maybeSingle: vi.fn(), revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/features/organizations/current", () => ({ getCurrentOrganization: mocks.organization }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from }) }));
import { setNfcCardStatusAction } from "./actions";

function input(id = "12", status = "inactive") {
  const data = new FormData();
  data.set("id", id);
  data.set("status", status);
  data.set("organization_id", "999"); // Forged ownership must be ignored.
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.organization.mockResolvedValue({ id: 7 });
  const query = { update: mocks.update, eq: mocks.eq, select: mocks.select, maybeSingle: mocks.maybeSingle };
  mocks.from.mockReturnValue(query);
  mocks.update.mockReturnValue(query);
  mocks.eq.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: { id: 12 }, error: null });
});

it.each(["active", "inactive"])("sets %s using authenticated organization, never browser ownership", async (status) => {
  expect(await setNfcCardStatusAction(input("12", status))).toEqual({});
  expect(mocks.from).toHaveBeenCalledWith("nfc_cards");
  expect(mocks.update).toHaveBeenCalledWith({ status });
  expect(mocks.eq.mock.calls).toEqual([["id", 12], ["organization_id", 7]]);
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/nfc-cards");
});

it("rejects callers without an authenticated organization before any write", async () => {
  mocks.organization.mockResolvedValue(null);
  expect(await setNfcCardStatusAction(input())).toHaveProperty("error");
  expect(mocks.from).not.toHaveBeenCalled();
});

it.each([["0", "active"], ["-1", "active"], ["1.5", "active"], ["abc", "active"], ["12", "deleted"]])("rejects invalid input %s / %s", async (id, status) => {
  expect(await setNfcCardStatusAction(input(id, status))).toHaveProperty("error");
  expect(mocks.from).not.toHaveBeenCalled();
});

it.each([
  { data: null, error: null },
  { data: null, error: { message: "private policy details" } },
])("does not report success when no authorized row was updated", async (result) => {
  mocks.maybeSingle.mockResolvedValue(result);
  const outcome = await setNfcCardStatusAction(input());
  expect(outcome.error).toBeTruthy();
  expect(outcome.error).not.toContain("private policy");
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
});
