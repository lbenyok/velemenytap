import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import {
  FeedbackFilters,
  type LocationOption,
  type CardOption,
} from "@/features/feedback/feedback-filters";
import { FeedbackTable } from "@/features/feedback/feedback-table";
import type { FeedbackDetailRow } from "@/features/feedback/feedback-detail-dialog";

export const metadata: Metadata = { title: "Vélemények — VéleményTap" };

const PAGE_SIZE = 20;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+\d{2}:\d{2}|Z)$/;

/**
 * Both fields end up interpolated into a raw PostgREST .or() filter string
 * below (needed for the compound seek predicate -- supabase-js's query
 * builder has no first-class "row value < row value" helper). Validating
 * their shape first, rather than passing whatever a manipulated dashboard
 * URL contains straight through, keeps that string free of anything but a
 * timestamp and an integer -- a malformed or hostile cursor is treated as
 * no cursor (first page) rather than passed through.
 */
function parseCursor(cursor: string | undefined, cursorId: string | undefined) {
  if (!cursor || !cursorId || !ISO_TIMESTAMP_RE.test(cursor)) return null;
  const id = Number(cursorId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { createdAt: cursor, id };
}

type SearchParams = {
  status?: string;
  rating?: string;
  location?: string;
  card?: string;
  days?: string;
  cursor?: string;
  cursorId?: string;
};

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const organization = await getCurrentOrganization();
  const supabase = await createClient();
  const orgId = organization?.id ?? 0;

  const VALID_STATUSES = ["new", "in_progress", "resolved"] as const;
  const status = VALID_STATUSES.find((s) => s === sp.status) ?? "all";
  const rating = sp.rating ?? "all";
  const locationId = sp.location ?? "all";
  const cardId = sp.card ?? "all";
  const days = sp.days ?? "all";

  let query = supabase
    .from("feedback")
    .select(
      "id, rating, feedback_text, status, priority, internal_note, created_at, locations(name), nfc_cards(display_name)",
    )
    .eq("organization_id", orgId)
    // id as a secondary sort key: created_at alone ties whenever two rows
    // land in the same instant (a realistic burst, not just a theoretical
    // one -- see the migration adding the matching index). id is a strictly
    // increasing identity column, so (created_at, id) is a true total order
    // with no possibility of its own ties.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (status !== "all") query = query.eq("status", status);
  if (rating !== "all") query = query.eq("rating", Number(rating));
  if (locationId !== "all") query = query.eq("location_id", Number(locationId));
  if (cardId !== "all") query = query.eq("nfc_card_id", Number(cardId));
  if (days !== "all") {
    // This is a plain async Server Component running once per request, not
    // something the React Compiler memoizes or double-invokes -- reading
    // the current time here to build a "last N days" filter is correct,
    // not a purity violation the rule is meant to catch.
    // eslint-disable-next-line react-hooks/purity -- see comment above
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }
  const cursor = parseCursor(sp.cursor, sp.cursorId);
  if (cursor) {
    // Seek predicate matching the (created_at, id) order above: strictly
    // before the cursor's created_at, OR tied on created_at and strictly
    // before its id. A plain `created_at < cursor` would skip whichever
    // same-created_at rows didn't happen to land before the page boundary.
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const [{ data: feedback }, { data: locations }, { data: cards }] = await Promise.all([
    query,
    supabase
      .from("locations")
      .select("id, name")
      .eq("organization_id", orgId)
      .order("name", { ascending: true }),
    supabase
      .from("nfc_cards")
      .select("id, display_name, locations(name)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true }),
  ]);

  const rows = feedback ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  const detailRows: FeedbackDetailRow[] = pageRows.map((f) => ({
    id: f.id,
    rating: f.rating,
    feedback_text: f.feedback_text,
    status: f.status,
    priority: f.priority,
    internal_note: f.internal_note,
    created_at: f.created_at,
    location_name: f.locations?.name ?? "—",
    card_name: f.nfc_cards?.display_name ?? null,
  }));

  const locationOptions: LocationOption[] = (locations ?? []).map((l) => ({
    value: String(l.id),
    label: l.name,
  }));

  const cardOptions: CardOption[] = (cards ?? []).map((c) => ({
    value: String(c.id),
    label: c.display_name
      ? `${c.display_name} (${c.locations?.name ?? "—"})`
      : `Névtelen kártya (${c.locations?.name ?? "—"})`,
  }));

  const hasActiveFilters =
    status !== "all" ||
    rating !== "all" ||
    locationId !== "all" ||
    cardId !== "all" ||
    days !== "all";

  const nextParams = new URLSearchParams();
  if (status !== "all") nextParams.set("status", status);
  if (rating !== "all") nextParams.set("rating", rating);
  if (locationId !== "all") nextParams.set("location", locationId);
  if (cardId !== "all") nextParams.set("card", cardId);
  if (days !== "all") nextParams.set("days", days);
  if (hasMore) {
    const lastRow = pageRows[pageRows.length - 1];
    nextParams.set("cursor", lastRow.created_at);
    nextParams.set("cursorId", String(lastRow.id));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Vélemények</h1>
        <p className="text-sm text-muted-foreground">
          Minden, amit a vásárlók beküldtek, legújabb elöl.
        </p>
      </div>
      <Suspense>
        <FeedbackFilters locations={locationOptions} cards={cardOptions} />
      </Suspense>
      <FeedbackTable rows={detailRows} hasActiveFilters={hasActiveFilters} />
      {hasMore ? (
        <div className="flex justify-center">
          <Link
            href={`/dashboard/feedback?${nextParams.toString()}`}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Régebbi vélemények betöltése
          </Link>
        </div>
      ) : null}
    </div>
  );
}
