// No "server-only" guard here (unlike overview-data.ts/queries.ts, which
// import these): pure parsing logic with no secrets or server APIs of its
// own, kept separate specifically so the R2-04 error-handling path (a
// failed RPC call must surface as an explicit "unavailable" result, never
// silently render as an empty-but-valid "0 feedback" state) is directly
// unit-testable without needing to break a live database connection to
// exercise it.

import type { OverviewStats, RecentFeedbackItem } from "./overview-data";
import type { AnalyticsData, RatingBucket, DailyPoint, LocationStats, CardStats } from "./queries";

type RpcResult = { data: unknown; error: unknown };

type OverviewSnapshot = {
  total: number;
  averageRating: number | null;
  todayCount: number;
  thisWeekCount: number;
  unresolvedNegativeCount: number;
  ratingCounts: Record<"1" | "2" | "3" | "4" | "5", number>;
  recent: {
    id: number;
    rating: number;
    feedbackText: string | null;
    status: string;
    createdAt: string;
    locationName: string;
  }[];
};

function ratingBuckets(counts: Record<"1" | "2" | "3" | "4" | "5", number>): RatingBucket[] {
  return ([1, 2, 3, 4, 5] as const).map((rating) => ({
    rating,
    count: counts[String(rating) as "1" | "2" | "3" | "4" | "5"] ?? 0,
  }));
}

export function parseOverviewSnapshot(result: RpcResult): OverviewStats {
  if (result.error || !result.data) {
    console.error("getOverviewStats: get_feedback_overview_snapshot failed", result.error);
    return { unavailable: true };
  }

  const snapshot = result.data as unknown as OverviewSnapshot;
  const recent: RecentFeedbackItem[] = snapshot.recent.map((r) => ({
    id: r.id,
    rating: r.rating,
    feedback_text: r.feedbackText,
    status: r.status,
    created_at: r.createdAt,
    location_name: r.locationName,
  }));

  return {
    unavailable: false,
    total: snapshot.total,
    averageRating:
      snapshot.averageRating !== null ? Number(snapshot.averageRating.toFixed(1)) : null,
    today: snapshot.todayCount,
    thisWeek: snapshot.thisWeekCount,
    unresolvedNegative: snapshot.unresolvedNegativeCount,
    distribution: ratingBuckets(snapshot.ratingCounts),
    recent,
  };
}

type PeriodAnalyticsSnapshot = {
  total: number;
  resolvedCount: number;
  ratingCounts: Record<"1" | "2" | "3" | "4" | "5", number>;
  dailySeries: { day: string; count: number; avgRating: number | null }[];
  byLocation: {
    locationId: number;
    locationName: string;
    count: number;
    avgRating: number;
    resolvedPct: number | null;
  }[];
  byCard: {
    cardId: number;
    cardName: string | null;
    locationName: string;
    count: number;
    avgRating: number;
  }[];
};

export function parsePeriodAnalytics(result: RpcResult): AnalyticsData {
  if (result.error || !result.data) {
    console.error("getAnalyticsData: get_feedback_period_analytics failed", result.error);
    return { unavailable: true };
  }

  const snapshot = result.data as unknown as PeriodAnalyticsSnapshot;
  const resolvedPct =
    snapshot.total > 0 ? Math.round((snapshot.resolvedCount / snapshot.total) * 100) : 0;

  const dailySeries: DailyPoint[] = snapshot.dailySeries.map((d) => ({
    day: d.day,
    count: d.count,
    avgRating: d.avgRating !== null ? Number(d.avgRating.toFixed(2)) : null,
  }));

  const byLocation: LocationStats[] = snapshot.byLocation.map((l) => ({
    locationId: l.locationId,
    name: l.locationName,
    count: l.count,
    avgRating: Number(l.avgRating.toFixed(1)),
    resolvedPct: Math.round(l.resolvedPct ?? 0),
  }));

  const byCard: CardStats[] = snapshot.byCard.map((c) => ({
    cardId: c.cardId,
    name: c.cardName ?? "Untitled card",
    locationName: c.locationName,
    count: c.count,
    avgRating: Number(c.avgRating.toFixed(1)),
  }));

  return {
    unavailable: false,
    total: snapshot.total,
    resolved: { resolved: snapshot.resolvedCount, total: snapshot.total, pct: resolvedPct },
    distribution: ratingBuckets(snapshot.ratingCounts),
    dailySeries,
    byLocation,
    byCard,
  };
}
