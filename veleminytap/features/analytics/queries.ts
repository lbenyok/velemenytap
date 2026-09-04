import "server-only";

import { createClient } from "@/lib/supabase/server";
import { parsePeriodAnalytics } from "./parse-snapshots";

export type DailyPoint = { day: string; count: number; avgRating: number | null };
export type RatingBucket = { rating: number; count: number };
export type LocationStats = {
  locationId: number;
  name: string;
  count: number;
  avgRating: number;
  resolvedPct: number;
};
export type CardStats = {
  cardId: number;
  name: string;
  locationName: string;
  count: number;
  avgRating: number;
};

export type AnalyticsData =
  | {
      unavailable: false;
      total: number;
      resolved: { resolved: number; total: number; pct: number };
      distribution: RatingBucket[];
      dailySeries: DailyPoint[];
      byLocation: LocationStats[];
      byCard: CardStats[];
    }
  | { unavailable: true };

/**
 * Computed entirely inside get_feedback_period_analytics (see its
 * migration) rather than paginating raw rows into Node and reducing them
 * client-side -- see overview-data.ts's identical comment for why (round-2
 * findings R2-02, R2-03: a page-by-page ceiling is still a ceiling, and
 * OFFSET pagination is not consistent across separate requests under
 * concurrent inserts). One SQL statement computes the total, the daily
 * series, the per-location breakdown, and the per-card breakdown from the
 * same underlying scan, so they can never disagree with each other about
 * which rows exist -- see that migration's comment for the exact
 * consistency semantics this does and does not guarantee.
 *
 * A failed query surfaces as `unavailable: true`, not a silently-empty
 * "0 feedback this period" (R2-04). Parsing/error-handling lives in
 * parse-snapshots.ts so it's unit-testable without a live database.
 */
export async function getAnalyticsData(
  organizationId: number,
  days: number,
): Promise<AnalyticsData> {
  const supabase = await createClient();

  // p_since is no longer passed -- the database function derives it from
  // p_days itself and validates p_days against an explicit allowlist
  // (round-3 finding R3-04: an arbitrary, caller-controlled p_days forced
  // an unbounded generate_series; p_since was also redundant with it in
  // every legitimate call, one more caller-trusted value than necessary).
  // Not .single() -- see overview-data.ts's identical comment.
  const result = await supabase.rpc("get_feedback_period_analytics", {
    p_organization_id: organizationId,
    p_days: days,
  });

  return parsePeriodAnalytics(result);
}
