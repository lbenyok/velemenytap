import "server-only";

import { createClient } from "@/lib/supabase/server";
import { ratingDistribution, type RatingBucket } from "./aggregate";

export type RecentFeedbackItem = {
  id: number;
  rating: number;
  feedback_text: string | null;
  status: string;
  created_at: string;
  location_name: string;
};

export type OverviewStats = {
  total: number;
  averageRating: number | null;
  today: number;
  thisWeek: number;
  unresolvedNegative: number;
  distribution: RatingBucket[];
  recent: RecentFeedbackItem[];
};

// All-time, not period-scoped (unlike /dashboard/analytics) -- these are
// meant to be the at-a-glance numbers on the homepage. Bounded the same way
// as the analytics query for the same reason: fine at MVP scale, see that
// file's comment.
const MAX_ROWS = 5000;

export async function getOverviewStats(organizationId: number): Promise<OverviewStats> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("feedback")
    .select("id, rating, status, feedback_text, created_at, locations(name)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  const rows = data ?? [];
  const total = rows.length;
  const averageRating =
    total > 0 ? Number((rows.reduce((sum, r) => sum + r.rating, 0) / total).toFixed(1)) : null;

  // "Today" and "this week" are UTC-day-based and rolling-7-day
  // respectively, same semantics as the Analytics period selector (not a
  // calendar week starting Monday) -- kept consistent rather than
  // introducing a second definition of "week" elsewhere in the app.
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

  const today = rows.filter((r) => new Date(r.created_at) >= todayStart).length;
  const thisWeek = rows.filter((r) => new Date(r.created_at) >= weekStart).length;
  const unresolvedNegative = rows.filter(
    (r) => r.rating <= 2 && r.status !== "resolved",
  ).length;

  const recent: RecentFeedbackItem[] = rows.slice(0, 5).map((r) => ({
    id: r.id,
    rating: r.rating,
    feedback_text: r.feedback_text,
    status: r.status,
    created_at: r.created_at,
    location_name: r.locations?.name ?? "—",
  }));

  return {
    total,
    averageRating,
    today,
    thisWeek,
    unresolvedNegative,
    distribution: ratingDistribution(rows),
    recent,
  };
}
