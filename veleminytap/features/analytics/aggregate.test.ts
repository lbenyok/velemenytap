import { describe, it, expect } from "vitest";
import {
  dailySeries,
  ratingDistribution,
  resolvedStats,
  byLocation,
  byCard,
  type FeedbackRow,
} from "./aggregate";

function row(overrides: Partial<FeedbackRow>): FeedbackRow {
  return {
    id: 1,
    rating: 5,
    status: "new",
    location_id: 1,
    nfc_card_id: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ratingDistribution", () => {
  it("counts each rating 1-5 into its own bucket", () => {
    const rows = [{ rating: 1 }, { rating: 1 }, { rating: 3 }, { rating: 5 }, { rating: 5 }, { rating: 5 }];
    const buckets = ratingDistribution(rows);
    expect(buckets).toEqual([
      { rating: 1, count: 2 },
      { rating: 2, count: 0 },
      { rating: 3, count: 1 },
      { rating: 4, count: 0 },
      { rating: 5, count: 3 },
    ]);
  });

  it("returns all-zero buckets for no rows", () => {
    expect(ratingDistribution([])).toEqual([
      { rating: 1, count: 0 },
      { rating: 2, count: 0 },
      { rating: 3, count: 0 },
      { rating: 4, count: 0 },
      { rating: 5, count: 0 },
    ]);
  });

  it("ignores out-of-range ratings rather than corrupting a bucket", () => {
    const buckets = ratingDistribution([{ rating: 0 }, { rating: 6 }, { rating: 3 }]);
    expect(buckets.find((b) => b.rating === 3)?.count).toBe(1);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });
});

describe("dailySeries", () => {
  it("zero-fills days with no feedback", () => {
    const series = dailySeries([], 7);
    expect(series).toHaveLength(7);
    expect(series.every((p) => p.count === 0 && p.avgRating === null)).toBe(true);
  });

  it("ends on today (UTC) and buckets by UTC calendar day", () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const series = dailySeries([row({ rating: 4, created_at: new Date().toISOString() })], 3);
    expect(series[series.length - 1].day).toBe(todayKey);
    expect(series[series.length - 1].count).toBe(1);
    expect(series[series.length - 1].avgRating).toBe(4);
  });

  it("averages multiple ratings on the same day", () => {
    const now = new Date().toISOString();
    const series = dailySeries([row({ rating: 2, created_at: now }), row({ rating: 4, created_at: now })], 1);
    expect(series[0].count).toBe(2);
    expect(series[0].avgRating).toBe(3);
  });
});

describe("resolvedStats", () => {
  it("computes resolved percentage, rounded", () => {
    const rows = [
      row({ status: "resolved" }),
      row({ status: "resolved" }),
      row({ status: "new" }),
    ];
    expect(resolvedStats(rows)).toEqual({ resolved: 2, total: 3, pct: 67 });
  });

  it("reports 0% for no feedback rather than dividing by zero", () => {
    expect(resolvedStats([])).toEqual({ resolved: 0, total: 0, pct: 0 });
  });
});

describe("byLocation", () => {
  it("groups and averages per location, sorted by volume descending", () => {
    const rows = [
      row({ location_id: 1, rating: 5, status: "resolved" }),
      row({ location_id: 1, rating: 3 }),
      row({ location_id: 2, rating: 4 }),
    ];
    const names = new Map([
      [1, "Main Street"],
      [2, "Side Street"],
    ]);
    const stats = byLocation(rows, names);
    expect(stats[0]).toEqual({
      locationId: 1,
      name: "Main Street",
      count: 2,
      avgRating: 4,
      resolvedPct: 50,
    });
    expect(stats[1].locationId).toBe(2);
  });

  it("falls back to a placeholder name for an unknown location id", () => {
    const stats = byLocation([row({ location_id: 99 })], new Map());
    expect(stats[0].name).toBe("Unknown location");
  });
});

describe("byCard", () => {
  it("groups and averages per card", () => {
    const rows = [row({ nfc_card_id: 1, rating: 2 }), row({ nfc_card_id: 1, rating: 4 })];
    const info = new Map([[1, { name: "Front counter", locationName: "Main Street" }]]);
    const stats = byCard(rows, info);
    expect(stats).toEqual([
      { cardId: 1, name: "Front counter", locationName: "Main Street", count: 2, avgRating: 3 },
    ]);
  });
});
