import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { FeedbackRow } from "./aggregate";

export type AnalyticsData = {
  feedback: FeedbackRow[];
  locationNames: Map<number, string>;
  cardInfo: Map<number, { name: string; locationName: string }>;
};

// Bounded so this stays a plain in-memory aggregation instead of needing a
// SQL view/RPC -- fine at MVP scale (see the analytics page's comment for
// why this is deliberate, not a scale plan).
const MAX_ROWS = 5000;

export async function getAnalyticsData(
  organizationId: number,
  days: number,
): Promise<AnalyticsData> {
  const supabase = await createClient();

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const [{ data: feedback }, { data: locations }, { data: cards }] = await Promise.all([
    supabase
      .from("feedback")
      .select("id, rating, status, location_id, nfc_card_id, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_ROWS),
    supabase.from("locations").select("id, name").eq("organization_id", organizationId),
    supabase
      .from("nfc_cards")
      .select("id, display_name, locations(name)")
      .eq("organization_id", organizationId),
  ]);

  const locationNames = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const cardInfo = new Map(
    (cards ?? []).map((c) => [
      c.id,
      { name: c.display_name ?? "Untitled card", locationName: c.locations?.name ?? "—" },
    ]),
  );

  return { feedback: feedback ?? [], locationNames, cardInfo };
}
