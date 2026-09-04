import { describe, it, expect, vi } from "vitest";
import { parseOverviewSnapshot, parsePeriodAnalytics } from "./parse-snapshots";

const okOverviewSnapshot = {
  total: 3,
  averageRating: 4.333333,
  todayCount: 1,
  thisWeekCount: 2,
  unresolvedNegativeCount: 0,
  ratingCounts: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 2 },
  recent: [
    {
      id: 1,
      rating: 5,
      feedbackText: "Great!",
      status: "new",
      createdAt: "2026-09-04T10:00:00Z",
      locationName: "Main Street",
    },
  ],
};

const okPeriodSnapshot = {
  total: 10,
  resolvedCount: 4,
  ratingCounts: { "1": 1, "2": 1, "3": 2, "4": 3, "5": 3 },
  dailySeries: [{ day: "2026-09-04", count: 10, avgRating: 3.7 }],
  byLocation: [
    { locationId: 1, locationName: "Main Street", count: 10, avgRating: 3.7, resolvedPct: 40 },
  ],
  byCard: [{ cardId: 1, cardName: "Front desk", locationName: "Main Street", count: 10, avgRating: 3.7 }],
};

describe("parseOverviewSnapshot (round-2 finding R2-04: error handling)", () => {
  it("returns unavailable:true on an RPC error, not a zeroed-out valid result", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseOverviewSnapshot({ data: null, error: { message: "connection reset" } });
    expect(result).toEqual({ unavailable: true });
    // Must not be confusable with a real "empty organization" result --
    // there is no `total: 0` sitting alongside `unavailable`.
    expect(result).not.toHaveProperty("total");
    consoleError.mockRestore();
  });

  it("returns unavailable:true when data is null even without an explicit error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseOverviewSnapshot({ data: null, error: null });
    expect(result).toEqual({ unavailable: true });
    consoleError.mockRestore();
  });

  it("logs the underlying error for observability rather than swallowing it silently", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = { message: "permission denied", code: "42501" };
    parseOverviewSnapshot({ data: null, error: dbError });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("failed"), dbError);
    consoleError.mockRestore();
  });

  it("correctly parses a genuinely successful, valid snapshot", () => {
    const result = parseOverviewSnapshot({ data: okOverviewSnapshot, error: null });
    expect(result.unavailable).toBe(false);
    if (result.unavailable) throw new Error("unreachable");
    expect(result.total).toBe(3);
    expect(result.averageRating).toBe(4.3);
    expect(result.today).toBe(1);
    expect(result.thisWeek).toBe(2);
    expect(result.distribution).toEqual([
      { rating: 1, count: 0 },
      { rating: 2, count: 0 },
      { rating: 3, count: 0 },
      { rating: 4, count: 1 },
      { rating: 5, count: 2 },
    ]);
    expect(result.recent).toEqual([
      {
        id: 1,
        rating: 5,
        feedback_text: "Great!",
        status: "new",
        created_at: "2026-09-04T10:00:00Z",
        location_name: "Main Street",
      },
    ]);
  });

  it("a genuinely empty organization (real zero, not a failure) is distinguishable from unavailable", () => {
    const empty = { ...okOverviewSnapshot, total: 0, averageRating: null, recent: [] };
    const result = parseOverviewSnapshot({ data: empty, error: null });
    expect(result).toEqual({
      unavailable: false,
      total: 0,
      averageRating: null,
      today: 1,
      thisWeek: 2,
      unresolvedNegative: 0,
      distribution: [
        { rating: 1, count: 0 },
        { rating: 2, count: 0 },
        { rating: 3, count: 0 },
        { rating: 4, count: 1 },
        { rating: 5, count: 2 },
      ],
      recent: [],
    });
  });
});

describe("parsePeriodAnalytics (round-2 finding R2-04: error handling)", () => {
  it("returns unavailable:true on an RPC error, not a zeroed-out valid result", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parsePeriodAnalytics({ data: null, error: { message: "timeout" } });
    expect(result).toEqual({ unavailable: true });
    expect(result).not.toHaveProperty("total");
    consoleError.mockRestore();
  });

  it("correctly parses a genuinely successful snapshot, including derived resolvedPct", () => {
    const result = parsePeriodAnalytics({ data: okPeriodSnapshot, error: null });
    expect(result.unavailable).toBe(false);
    if (result.unavailable) throw new Error("unreachable");
    expect(result.total).toBe(10);
    expect(result.resolved).toEqual({ resolved: 4, total: 10, pct: 40 });
    expect(result.dailySeries).toEqual([{ day: "2026-09-04", count: 10, avgRating: 3.7 }]);
    expect(result.byLocation).toEqual([
      { locationId: 1, name: "Main Street", count: 10, avgRating: 3.7, resolvedPct: 40 },
    ]);
    expect(result.byCard).toEqual([
      { cardId: 1, name: "Front desk", locationName: "Main Street", count: 10, avgRating: 3.7 },
    ]);
  });

  it("falls back to 'Untitled card' when cardName is null, and 0% resolved when total is 0", () => {
    const snapshot = {
      ...okPeriodSnapshot,
      total: 0,
      resolvedCount: 0,
      byCard: [{ cardId: 2, cardName: null, locationName: "Main Street", count: 0, avgRating: 0 }],
    };
    const result = parsePeriodAnalytics({ data: snapshot, error: null });
    expect(result.unavailable).toBe(false);
    if (result.unavailable) throw new Error("unreachable");
    expect(result.resolved.pct).toBe(0);
    expect(result.byCard[0].name).toBe("Untitled card");
  });
});
