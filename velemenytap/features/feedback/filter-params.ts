/**
 * Shared, strict parsing for the feedback inbox's URL-driven filters and
 * cursor. Ported from an independent product audit (2026-09-08).
 *
 * The previous inline version validated only `status`, and passed `rating`/
 * `location`/`card`/`days` straight from the query string into `Number(...)`
 * and into the PostgREST filter -- so `?rating=abc` reached the database as
 * `NaN`, and `?days=abc` produced an `Invalid Date` cutoff. Every field is
 * now checked against the exact set of values the UI can actually produce,
 * and anything else degrades to "all" rather than being forwarded.
 *
 * Repeated parameters matter too: Next.js gives `?rating=1&rating=2` as an
 * array, so the `typeof value === "string"` guards below are load-bearing,
 * not incidental.
 */
type FilterParams = Partial<
  Record<"status" | "rating" | "location" | "card" | "days", unknown>
>;

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | "all" {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : "all";
}

function positiveId(value: unknown): string | "all" {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return "all";
  return Number.isSafeInteger(Number(value)) ? value : "all";
}

/** URL parameters are untrusted, including repeated parameters (arrays). */
export function parseFeedbackFilters(params: FilterParams) {
  return {
    status: choice(params.status, ["new", "in_progress", "resolved"]),
    rating: choice(params.rating, ["1", "2", "3", "4", "5"]),
    locationId: positiveId(params.location),
    cardId: positiveId(params.card),
    days: choice(params.days, ["7", "30", "90"]),
  };
}

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(\+\d{2}:\d{2}|Z)$/;

/**
 * The cursor is interpolated into a raw PostgREST `.or()` filter string (the
 * compound seek predicate has no first-class query-builder helper), so accept
 * only its exact shape -- a malformed or hostile cursor becomes "no cursor"
 * (first page) rather than reaching that string.
 */
export function parseFeedbackCursor(timestamp: unknown, rawId: unknown) {
  const id = positiveId(rawId);
  if (
    typeof timestamp !== "string" ||
    !ISO_TIMESTAMP.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    id === "all"
  ) {
    return null;
  }
  return { createdAt: timestamp, id: Number(id) };
}
