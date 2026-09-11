import { beforeEach, describe, expect, it, vi } from "vitest"

const { currentOrganization, from, revalidatePath } = vi.hoisted(() => ({
  currentOrganization: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock("@/features/organizations/current", () => ({
  getCurrentOrganization: currentOrganization,
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from }),
}))
vi.mock("next/cache", () => ({ revalidatePath }))

import { setLocationStatusAction } from "./actions"
import { setNfcCardStatusAction } from "@/features/nfc-cards/actions"

beforeEach(() => {
  vi.clearAllMocks()
  currentOrganization.mockResolvedValue({ id: 42 })
})

function statusForm(id = "7") {
  const form = new FormData()
  form.set("id", id)
  form.set("status", "inactive")
  return form
}

describe.each([
  { name: "location", table: "locations", action: setLocationStatusAction },
  { name: "card", table: "nfc_cards", action: setNfcCardStatusAction },
])("$name status mutation", ({ action, table }) => {
  it.each([
    { data: null, error: { message: "database unavailable" } },
    { data: null, error: null },
  ])(
    "reports failed/missing writes without reporting success",
    async (result) => {
      const chain = {
        update: vi.fn(),
        eq: vi.fn(),
        select: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue(result),
      }
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)
      chain.select.mockReturnValue(chain)
      from.mockReturnValue(chain)
      expect(await action(statusForm())).toHaveProperty("error")
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  )
  it("changes only the member's organization and confirms the saved row", async () => {
    const chain = {
      update: vi.fn(),
      eq: vi.fn(),
      select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 7 }, error: null }),
    }
    chain.update.mockReturnValue(chain)
    chain.eq.mockReturnValue(chain)
    chain.select.mockReturnValue(chain)
    from.mockReturnValue(chain)
    expect(await action(statusForm())).toEqual({})
    expect(from).toHaveBeenCalledWith(table)
    expect(chain.eq).toHaveBeenCalledWith("id", 7)
    expect(chain.eq).toHaveBeenCalledWith("organization_id", 42)
    expect(revalidatePath).toHaveBeenCalled()
  })
  it("does not write without membership", async () => {
    currentOrganization.mockResolvedValue(null)
    expect(await action(statusForm())).toHaveProperty("error")
    expect(from).not.toHaveBeenCalled()
  })
  it("does not write an invalid status or identifier", async () => {
    const form = statusForm("abc")
    expect(await action(form)).toHaveProperty("error")
    form.set("id", "7")
    form.set("status", "deleted")
    expect(await action(form)).toHaveProperty("error")
    expect(from).not.toHaveBeenCalled()
  })
})
