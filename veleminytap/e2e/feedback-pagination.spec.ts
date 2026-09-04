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
 * Finding #9: the feedback inbox's cursor pagination ordered and seeked on
 * created_at alone. Two rows sharing the exact same created_at (a realistic
 * burst, not just theoretical -- see the migration adding the
 * (organization_id, created_at, id) index) had no deterministic order
 * between them, and a page boundary landing inside a tied group could
 * silently skip whichever of them wasn't on the earlier page. This seeds 25
 * rows with an IDENTICAL created_at (forcing every row into one tied group
 * that spans the page-1/page-2 boundary) and confirms all 25 -- no fewer,
 * no duplicates -- appear across the two pages.
 */

const ROW_COUNT = 25;
const PAGE_SIZE = 20;

let member: SeededOrgMember;
let card: SeededCard;

test.beforeEach(async () => {
  member = await seedOrgWithMember("feedback-pagination");
  card = await seedActiveCard(member.orgId, "feedback-pagination");

  const admin = adminClient();
  const tiedTimestamp = new Date().toISOString();
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    organization_id: member.orgId,
    location_id: card.locationId,
    nfc_card_id: card.cardId,
    rating: 5,
    feedback_text: `Row ${String(i + 1).padStart(2, "0")}`,
    created_at: tiedTimestamp,
  }));
  const { error } = await admin.from("feedback").insert(rows);
  expect(error).toBeNull();
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("every row with a tied created_at appears exactly once across pages, none skipped", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/dashboard/feedback");

  // Insertion order (id ascending) is the tiebreaker for the tied
  // created_at, and the page orders id descending -- so "Row 25" (inserted
  // last, highest id) is first, "Row 01" last. Page 1 should hold Row 25
  // down to Row 06; page 2 (after "load older") the remaining Row 05 down
  // to Row 01.
  const rowTexts = async () => page.locator("table tbody tr").allTextContents();

  const page1 = await rowTexts();
  expect(page1).toHaveLength(PAGE_SIZE);
  for (let i = 25; i >= 6; i--) {
    const label = `Row ${String(i).padStart(2, "0")}`;
    expect(page1.some((row) => row.includes(label)), `expected page 1 to contain ${label}`).toBe(true);
  }

  await page.getByRole("link", { name: "Régebbi vélemények betöltése" }).click();
  await page.waitForLoadState("networkidle");

  const page2 = await rowTexts();
  expect(page2).toHaveLength(ROW_COUNT - PAGE_SIZE);
  for (let i = 5; i >= 1; i--) {
    const label = `Row ${String(i).padStart(2, "0")}`;
    expect(page2.some((row) => row.includes(label)), `expected page 2 to contain ${label}`).toBe(true);
  }

  // No overlap between the two pages -- confirms the seek predicate, not
  // just that 25 rows exist somewhere across two loads.
  const allLabels = [...page1, ...page2];
  for (let i = 1; i <= ROW_COUNT; i++) {
    const label = `Row ${String(i).padStart(2, "0")}`;
    const occurrences = allLabels.filter((row) => row.includes(label)).length;
    expect(occurrences, `expected ${label} exactly once total`).toBe(1);
  }
});
