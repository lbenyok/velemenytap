import { describe, expect, it } from "vitest"
import { parseFeedbackCursor, parseFeedbackFilters } from "./filter-params"

describe("feedback URL filters", () => {
  it.each([
    "abc",
    "NaN",
    "Infinity",
    "1e309",
    "-1",
    "0",
    "9999999999999999",
    ["7", "30"],
  ])(
    "ignores a malformed period instead of constructing an invalid date: %s",
    (days) => {
      expect(parseFeedbackFilters({ days }).days).toBe("all")
    }
  )
  it("preserves every supported filter", () => {
    expect(
      parseFeedbackFilters({
        status: "new",
        rating: "2",
        location: "42",
        card: "91",
        days: "30",
      })
    ).toEqual({
      status: "new",
      rating: "2",
      locationId: "42",
      cardId: "91",
      days: "30",
    })
  })
  it("ignores invalid identifiers and ratings before a database request", () => {
    expect(
      parseFeedbackFilters({
        status: "bad",
        rating: "NaN",
        location: "-1",
        card: "9007199254740992",
      })
    ).toEqual({
      status: "all",
      rating: "all",
      locationId: "all",
      cardId: "all",
      days: "all",
    })
  })
})

describe("feedback seek cursor", () => {
  it("preserves database timestamp precision and tie-breaking ID", () => {
    expect(
      parseFeedbackCursor("2026-09-07T12:00:00.123456+00:00", "27")
    ).toEqual({ createdAt: "2026-09-07T12:00:00.123456+00:00", id: 27 })
  })
  it.each([
    ["2026-99-07T12:00:00Z", "27"],
    ["2026-09-07T12:00:00Z),id.gt.0", "27"],
    ["2026-09-07T12:00:00Z", "27,or(id.gt.0)"],
    ["2026-09-07T12:00:00Z", "9007199254740992"],
    [["2026-09-07T12:00:00Z"], "27"],
  ])("rejects malformed cursor %s / %s", (timestamp, id) => {
    expect(parseFeedbackCursor(timestamp, id)).toBeNull()
  })
})
