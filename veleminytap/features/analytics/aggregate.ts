export type FeedbackRow = {
  id: number;
  rating: number;
  status: string;
  location_id: number;
  nfc_card_id: number;
  created_at: string;
};

function dayKey(iso: string): string {
  // UTC calendar day. The schema has no per-organization timezone, so
  // "today" here means the UTC day -- a deliberate MVP simplification,
  // not an oversight. A single-timezone small business won't notice a
  // day-boundary skew of a few hours.
  return iso.slice(0, 10);
}

export type DailyPoint = { day: string; count: number; avgRating: number | null };

/** One point per day for the last `days` days, ending today (UTC), zero-filled. */
export function dailySeries(rows: FeedbackRow[], days: number): DailyPoint[] {
  const today = new Date();
  const series: DailyPoint[] = [];
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const countByDay = new Map<string, number>();
  const sumByDay = new Map<string, number>();

  for (const row of rows) {
    const key = dayKey(row.created_at);
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
    sumByDay.set(key, (sumByDay.get(key) ?? 0) + row.rating);
  }

  for (const day of dayKeys) {
    const count = countByDay.get(day) ?? 0;
    series.push({
      day,
      count,
      avgRating: count > 0 ? Number(((sumByDay.get(day) ?? 0) / count).toFixed(2)) : null,
    });
  }

  return series;
}

export type RatingBucket = { rating: number; count: number };

export function ratingDistribution(rows: { rating: number }[]): RatingBucket[] {
  const counts = [0, 0, 0, 0, 0];
  for (const row of rows) {
    if (row.rating >= 1 && row.rating <= 5) counts[row.rating - 1] += 1;
  }
  return counts.map((count, i) => ({ rating: i + 1, count }));
}

export function resolvedStats(rows: FeedbackRow[]) {
  const total = rows.length;
  const resolved = rows.filter((r) => r.status === "resolved").length;
  return { resolved, total, pct: total > 0 ? Math.round((resolved / total) * 100) : 0 };
}

export type LocationStats = {
  locationId: number;
  name: string;
  count: number;
  avgRating: number;
  resolvedPct: number;
};

export function byLocation(
  rows: FeedbackRow[],
  locationNames: Map<number, string>,
): LocationStats[] {
  const map = new Map<number, { count: number; ratingSum: number; resolved: number }>();
  for (const row of rows) {
    const entry = map.get(row.location_id) ?? { count: 0, ratingSum: 0, resolved: 0 };
    entry.count += 1;
    entry.ratingSum += row.rating;
    if (row.status === "resolved") entry.resolved += 1;
    map.set(row.location_id, entry);
  }
  return Array.from(map.entries())
    .map(([locationId, e]) => ({
      locationId,
      name: locationNames.get(locationId) ?? "Unknown location",
      count: e.count,
      avgRating: Number((e.ratingSum / e.count).toFixed(1)),
      resolvedPct: Math.round((e.resolved / e.count) * 100),
    }))
    .sort((a, b) => b.count - a.count);
}

export type CardStats = {
  cardId: number;
  name: string;
  locationName: string;
  count: number;
  avgRating: number;
};

export function byCard(
  rows: FeedbackRow[],
  cardInfo: Map<number, { name: string; locationName: string }>,
): CardStats[] {
  const map = new Map<number, { count: number; ratingSum: number }>();
  for (const row of rows) {
    const entry = map.get(row.nfc_card_id) ?? { count: 0, ratingSum: 0 };
    entry.count += 1;
    entry.ratingSum += row.rating;
    map.set(row.nfc_card_id, entry);
  }
  return Array.from(map.entries())
    .map(([cardId, e]) => {
      const info = cardInfo.get(cardId);
      return {
        cardId,
        name: info?.name ?? "Untitled card",
        locationName: info?.locationName ?? "—",
        count: e.count,
        avgRating: Number((e.ratingSum / e.count).toFixed(1)),
      };
    })
    .sort((a, b) => b.count - a.count);
}
