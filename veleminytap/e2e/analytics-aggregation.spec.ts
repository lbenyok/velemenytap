import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  userClient,
  type SeededOrgMember,
  type SeededCard,
} from "./support/seed";

/**
 * Round-2 findings R2-02 and R2-03. The round-1 fix for the original
 * 1000-row PostgREST cap (finding #7) paginated raw rows into Node with a
 * MAX_ROWS=5000 ceiling -- round 2 confirmed that's still a silent
 * truncation ceiling (R2-02, just a bigger one), and that OFFSET-based
 * pagination is not consistent across separate requests under concurrent
 * inserts (R2-03) regardless of any secondary sort key. Both are fixed by
 * computing every statistic inside a single, tenant-scoped SQL aggregate
 * function (get_feedback_overview_snapshot, get_feedback_period_analytics
 * -- see their migration's comment for the exact consistency semantics).
 * This file supersedes e2e/analytics-row-cap.spec.ts, whose premise (a
 * 1000-row ceiling reachable via page-by-page fetching) no longer applies
 * to this architecture at all.
 */

let member: SeededOrgMember;
let card: SeededCard;

test.beforeEach(async () => {
  member = await seedOrgWithMember("analytics-aggregation");
  card = await seedActiveCard(member.orgId, "analytics-aggregation");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("R2-02: the dashboard overview reflects the true total past the old 5000-row ceiling, with mixed ratings and statuses", async ({
  page,
}) => {
  const admin = adminClient();
  const ROW_COUNT = 5500;
  const ratings = [1, 2, 3, 4, 5];
  const statuses = ["new", "in_progress", "resolved"] as const;
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: ratings[i % ratings.length],
    status: statuses[i % statuses.length],
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("feedback").insert(rows.slice(i, i + 500));
    expect(error).toBeNull();
  }

  const expectedByRating: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let expectedUnresolvedNegative = 0;
  for (const r of rows) {
    expectedByRating[r.rating] += 1;
    if (r.rating <= 2 && r.status !== "resolved") expectedUnresolvedNegative += 1;
  }

  // Direct RPC check first (precise, fast) -- then confirm the same number
  // actually renders in the real dashboard UI.
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("get_feedback_overview_snapshot", {
    p_organization_id: member.orgId,
  });
  expect(error).toBeNull();
  const snapshot = data as {
    total: number;
    unresolvedNegativeCount: number;
    ratingCounts: Record<string, number>;
  };
  expect(snapshot.total).toBe(ROW_COUNT);
  expect(snapshot.unresolvedNegativeCount).toBe(expectedUnresolvedNegative);
  for (const rating of ratings) {
    expect(snapshot.ratingCounts[String(rating)]).toBe(expectedByRating[rating]);
  }

  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);

  const tile = page.locator('[data-slot="card-content"]', { hasText: "Összes vélemény" });
  await expect(tile).toContainText(String(ROW_COUNT));
});

test("R2-02: period analytics reflects the true total past the old 5000-row ceiling", async ({
  page,
}) => {
  const admin = adminClient();
  const ROW_COUNT = 6000;
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: (i % 5) + 1,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("feedback").insert(rows.slice(i, i + 500));
    expect(error).toBeNull();
  }

  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/dashboard/analytics?days=90");
  await expect(page.getByText(`${ROW_COUNT} beküldött vélemény`)).toBeVisible();
});

test("R2-03: a single aggregate call reflects one consistent snapshot under concurrent inserts, never a corrupted total", async () => {
  const admin = adminClient();
  const client = await userClient(member.email, member.password);

  const BASE_COUNT = 100;
  const CONCURRENT_INSERT_COUNT = 100;

  // Fully committed before the concurrent phase starts -- this is the
  // floor the aggregate call can never legitimately fall below, since
  // these rows exist before either concurrent operation begins.
  const baseRows = Array.from({ length: BASE_COUNT }, () => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: 5,
  }));
  const { error: seedError } = await admin.from("feedback").insert(baseRows);
  expect(seedError).toBeNull();

  // Fired together, not sequentially: the aggregate RPC call races a batch
  // of new inserts landing on the same table. A single SQL statement sees
  // one MVCC snapshot for its whole duration, so the result must reflect
  // *some* real, coherent point in time -- never less than what already
  // existed (BASE_COUNT), never more than what could possibly exist by the
  // time both operations finish (BASE_COUNT + CONCURRENT_INSERT_COUNT).
  // The old OFFSET-pagination approach had no such guarantee: a row
  // inserted mid-collection could shift every subsequent page's offsets,
  // causing an already-read row to reappear (pushing the total above the
  // true ceiling) or a not-yet-read row to be skipped entirely.
  const concurrentRows = Array.from({ length: CONCURRENT_INSERT_COUNT }, () => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: 3,
  }));

  const [rpcResult] = await Promise.all([
    client.rpc("get_feedback_overview_snapshot", { p_organization_id: member.orgId }),
    admin.from("feedback").insert(concurrentRows),
  ]);

  expect(rpcResult.error).toBeNull();
  const snapshot = rpcResult.data as { total: number };
  expect(snapshot.total).toBeGreaterThanOrEqual(BASE_COUNT);
  expect(snapshot.total).toBeLessThanOrEqual(BASE_COUNT + CONCURRENT_INSERT_COUNT);

  // And the final, settled state is exactly what both inserts together
  // produced -- no rows were lost or duplicated in the underlying table
  // itself, only the aggregate's mid-flight view of it was ever in
  // question.
  const { count: finalCount } = await admin
    .from("feedback")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", member.orgId);
  expect(finalCount).toBe(BASE_COUNT + CONCURRENT_INSERT_COUNT);
});
