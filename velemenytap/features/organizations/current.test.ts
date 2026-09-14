import { beforeEach, describe, expect, it, vi } from "vitest"

const { maybeSingle, eq, getClaims } = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  getClaims: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const query = {
      select: () => query,
      eq: (...args: unknown[]) => {
        eq(...args)
        return query
      },
      order: () => query,
      limit: () => query,
      maybeSingle,
    }
    return { from: () => query, auth: { getClaims } }
  },
}))
import { getCurrentOrganization } from "./current"

beforeEach(() => {
  vi.clearAllMocks()
  getClaims.mockResolvedValue({ data: { claims: { sub: "signed-in-user" } } })
})

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

  /**
   * Round-14 R14-04. This query used to have no user filter, so it read "the
   * earliest membership row I can SEE" and called it "my membership". The
   * roster is readable by every member of the organization, so ordering it by
   * created_at and taking the first row returned the OWNER's row to a staff
   * member -- and `canManageBilling` reads that role directly.
   *
   * Asserted end to end in e2e/tenant-isolation.spec.ts; asserted here at the
   * one place the filter can be dropped by an edit.
   */
  it("filters memberships to the verified caller, never to whatever is visible", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    await getCurrentOrganization()
    expect(eq).toHaveBeenCalledWith("user_id", "signed-in-user")
  })

  it("returns no organization, and never queries, without a verified user", async () => {
    getClaims.mockResolvedValue({ data: null })
    expect(await getCurrentOrganization()).toBeNull()
    // Fails closed: an unresolved identity must not fall through to an
    // unfiltered read of whatever RLS happens to allow.
    expect(maybeSingle).not.toHaveBeenCalled()
  })
})
