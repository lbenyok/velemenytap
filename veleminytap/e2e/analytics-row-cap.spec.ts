import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  type SeededOrgMember,
  type SeededCard,
} from "./support/seed";

/**
 * Finding #7: PostgREST caps any single response at max_rows (1000,
 * supabase/config.toml) regardless of what .limit() a query asks for --
 * confirmed empirically (1200 seeded rows, .limit(5000) requested, only
 * 1000 returned). getOverviewStats computed total/average/distribution from
 * that silently truncated result, so any organization with more than 1000
 * feedback rows in its history got a wrong "Összes vélemény" (total
 * feedback) count on the dashboard overview -- and every other stat derived
 * from the same rows. Fixed with page-by-page fetching past the cap
 * (features/analytics/fetch-all-rows.ts). This seeds 1200 real rows against
 * the isolated project and confirms the dashboard shows the true count.
 */

let member: SeededOrgMember;
let card: SeededCard;

test.beforeEach(async () => {
  member = await seedOrgWithMember("analytics-row-cap");
  card = await seedActiveCard(member.orgId, "analytics-row-cap");

  const admin = adminClient();
  const rows = Array.from({ length: 1200 }, () => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: 5,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("feedback").insert(rows.slice(i, i + 500));
    expect(error).toBeNull();
  }
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("the dashboard overview shows the true total, not PostgREST's 1000-row cap", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);

  const tile = page.locator('[data-slot="card-content"]', { hasText: "Összes vélemény" });
  await expect(tile).toContainText("1200");
  await expect(tile).not.toContainText("1000");
});
