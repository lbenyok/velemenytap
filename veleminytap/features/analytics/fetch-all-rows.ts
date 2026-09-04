// No "server-only" guard here (unlike its callers): this is a generic
// pagination helper with no secrets or server APIs of its own -- the
// server-only boundary is already enforced by overview-data.ts and
// queries.ts, which both import it, and the absence lets it be unit tested
// directly under plain Node/Vitest rather than only through e2e tests.

// PostgREST caps any single response at max_rows (supabase/config.toml,
// 1000) regardless of what .limit() a query asks for -- it silently
// truncates rather than erroring, so `.limit(5000)` on a table with more
// than 1000 matching rows was quietly returning only the newest 1000
// (confirmed: 1200 seeded rows, .limit(5000) requested, 1000 returned).
// For an org whose feedback history exceeds that, every all-time/period
// stat computed from the result (total, average rating, distribution, etc.)
// was wrong -- not degraded, wrong, with no error or indication anything
// was cut off.
//
// Fetches page by page instead of trusting a single .limit() past the cap.
// The first page also asks for the exact total count so the remaining
// pages can be requested in parallel rather than awaited one at a time.
const PAGE_SIZE = 1000;

type PageResult<T> = { data: T[] | null; count: number | null; error: unknown };

export async function fetchAllRowsPaginated<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxRows: number,
): Promise<T[]> {
  const first = await fetchPage(0, PAGE_SIZE - 1);
  if (first.error || !first.data) return [];

  const total = Math.min(first.count ?? first.data.length, maxRows);
  if (first.data.length < PAGE_SIZE || total <= PAGE_SIZE) {
    return first.data.slice(0, maxRows);
  }

  const remainingRanges: { from: number; to: number }[] = [];
  for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) {
    remainingRanges.push({ from, to: Math.min(from + PAGE_SIZE - 1, total - 1) });
  }

  const rest = await Promise.all(remainingRanges.map((r) => fetchPage(r.from, r.to)));
  const all = [first.data, ...rest.map((r) => r.data ?? [])].flat();
  return all.slice(0, maxRows);
}
