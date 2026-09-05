import "server-only";

import { createClient } from "@/lib/supabase/server";
import { parseOverviewSnapshot } from "./parse-snapshots";
import type { RatingBucket } from "./queries";

export type { RatingBucket };

export type RecentFeedbackItem = {
  id: number;
  rating: number;
  feedback_text: string | null;
  status: string;
  created_at: string;
  location_name: string;
};

export type OverviewStats =
  | {
      unavailable: false;
      total: number;
      averageRating: number | null;
      today: number;
      thisWeek: number;
      unresolvedNegative: number;
      distribution: RatingBucket[];
      recent: RecentFeedbackItem[];
    }
  | { unavailable: true };

/**
 * All-time, not period-scoped (unlike /dashboard/analytics) -- meant to be
 * the at-a-glance numbers on the homepage. Computed entirely inside
 * get_feedback_overview_snapshot (see its migration) rather than paginating
 * raw rows into Node: a round-2 review confirmed the prior page-by-page
 * approach still had a silent truncation ceiling (R2-02, just a bigger one
 * than the original 1000-row PostgREST cap) and was inconsistent under
 * concurrent inserts across separate page requests (R2-03). A single SQL
 * aggregate has neither problem -- there's no row-count ceiling to hit, and
 * Postgres computes the whole result from one consistent snapshot no
 * matter how many rows match.
 *
 * A failed query surfaces as an explicit `unavailable: true` result rather
 * than silently rendering as "0 feedback so far" (R2-04) -- an error and
 * an empty organization must never look the same to whoever reads this.
 * The actual parsing/error-handling logic lives in parse-snapshots.ts,
 * specifically so it's unit-testable without a live database.
 */
export async function getOverviewStats(organizationId: number): Promise<OverviewStats> {
  const supabase = await createClient();

  // Not .single() -- this function returns a scalar jsonb value, not a
  // set of rows, so PostgREST returns it directly rather than wrapping it
  // in an array for .single() to unwrap.
  const result = await supabase.rpc("get_feedback_overview_snapshot", {
    p_organization_id: organizationId,
  });

  return parseOverviewSnapshot(result);
}
