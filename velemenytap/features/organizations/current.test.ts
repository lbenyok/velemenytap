import { beforeEach, describe, expect, it, vi } from "vitest"

const { maybeSingle } = vi.hoisted(() => ({ maybeSingle: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const query = {
      select: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle,
    }
    return { from: () => query }
  },
}))
import { getCurrentOrganization } from "./current"

beforeEach(() => vi.clearAllMocks())
describe("organization lookup", () => {
  it("does not convert a query outage into an onboarding redirect", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "missing schema column" },
    })
    await expect(getCurrentOrganization()).rejects.toThrow(
      "Nem sikerült betölteni"
    )
  })
  it("still returns no organization for an account without membership", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await getCurrentOrganization()).toBeNull()
  })
})
