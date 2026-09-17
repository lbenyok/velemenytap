import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  rpc: vi.fn(),
  single: vi.fn(),
  sendAlert: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ after: mocks.after }))
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet }),
}))
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc }),
}))
vi.mock(
  "@/features/notifications/negative-feedback-alert",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/notifications/negative-feedback-alert")
    >()),
    sendNegativeFeedbackAlert: mocks.sendAlert,
  })
)

import { submitFeedbackAction } from "./actions"

const publicId = "346f9cff-2441-4adc-9f7f-b7a2de1db634"
function feedback(rating: number) {
  const data = new FormData()
  data.set("public_id", publicId)
  data.set("rating", String(rating))
  return data
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.rpc.mockReturnValue({ single: mocks.single })
  mocks.single.mockResolvedValue({
    data: {
      organization_id: 10,
      nfc_card_id: 20,
      organization_name: "Test café",
      location_name: "Test location",
      card_name: "Counter",
      google_review_url: "https://g.page/r/test/review",
    },
    error: null,
  })
})

describe("feedback saving and below-four-star alerts", () => {
  it.each([1, 2, 3, 4, 5])(
    "saves %i stars and schedules an alert only below four",
    async (rating) => {
      const result = await submitFeedbackAction(
        { status: "idle" },
        feedback(rating)
      )
      expect(result.status).toBe("success")
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
        "submit_feedback_atomic",
        {
          p_public_id: publicId,
          p_rating: rating,
          p_feedback_text: null,
        }
      )
      expect(mocks.cookieSet).toHaveBeenCalledOnce()
      expect(mocks.after).toHaveBeenCalledTimes(rating < 4 ? 1 : 0)
      if (rating < 4) {
        await mocks.after.mock.calls[0][0]()
        expect(mocks.sendAlert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ rating, organizationId: 10 })
        )
      } else {
        expect(mocks.sendAlert).not.toHaveBeenCalled()
      }
    }
  )

  it("does not claim success or schedule an alert when saving fails", async () => {
    mocks.single.mockResolvedValue({
      data: null,
      error: { code: "unexpected" },
    })
    expect(
      await submitFeedbackAction({ status: "idle" }, feedback(3))
    ).toMatchObject({ status: "error", code: "failed" })
    expect(mocks.after).not.toHaveBeenCalled()
    expect(mocks.cookieSet).not.toHaveBeenCalled()
  })

  it("rejects a duplicate without another write or alert", async () => {
    mocks.cookieGet.mockReturnValue({ value: "1" })
    expect(
      await submitFeedbackAction({ status: "idle" }, feedback(5))
    ).toMatchObject({ status: "error", code: "duplicate" })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })
})
