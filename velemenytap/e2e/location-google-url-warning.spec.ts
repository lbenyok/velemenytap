import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
  type SeededOrgMember,
} from "./support/seed";
import { signInViaUi } from "./support/ui";

/**
 * An active location with no Google review URL is this product's quietest
 * possible failure: cards work, submissions succeed, the feedback inbox
 * fills up, every dashboard number looks healthy -- and not one customer is
 * ever offered the Google review the whole product exists to produce.
 *
 * It used to be reported as muted grey "Nincs beállítva" text in a table
 * column, visually indistinguishable from a blank address in the column
 * beside it, on a page an owner visits once during setup. These tests hold
 * the state to being ACTIVELY surfaced: named on arrival at the Locations
 * page, and marked in its own row.
 *
 * The inactive case is asserted just as deliberately: a location that is
 * switched off collects nothing, so warning about it would be noise, and
 * this product's own rule is not to spam its users with alerts.
 */

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("google-url-warning");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

async function seedLocation(
  name: string,
  googleReviewUrl: string | null,
  status: "active" | "inactive" = "active",
): Promise<void> {
  const admin = adminClient();
  const { error } = await admin.from("locations").insert({
    organization_id: member.orgId,
    name,
    google_review_url: googleReviewUrl,
    status,
  });
  if (error) throw error;
}

/**
 * Next.js ships its own route announcer with role="alert", so getByRole("alert")
 * is ambiguous on every page of this app -- it matched the announcer as well as
 * the banner. Scoped to the Alert component itself (same [data-slot] convention
 * analytics-aggregation.spec.ts already uses for a Card).
 */
function warningBanner(page: import("@playwright/test").Page) {
  return page.locator('[data-slot="alert"]');
}

async function openLocations(page: import("@playwright/test").Page): Promise<void> {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL("/dashboard");
  await page.goto("/dashboard/locations");
}

test("an active location with no Google review URL is named in a warning on arrival", async ({
  page,
}) => {
  await seedLocation("E2E Kávézó Fő tér", null);
  await openLocations(page);

  const warning = warningBanner(page);
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Egy aktív helyszínhez nincs Google-értékelési link");
  // Naming it is the point -- a warning that says "some location" leaves the
  // owner to find which one by hand.
  await expect(warning).toContainText("E2E Kávézó Fő tér");

  // And the row itself, so the fix does not depend on the owner reading a
  // banner they can scroll past.
  const cell = page.getByRole("cell", { name: "Nincs beállítva" });
  await expect(cell).toBeVisible();
  // The text alone was already there when this was a defect -- in muted grey,
  // reading like a blank field rather than a problem. What makes it a warning
  // is the marker beside it, which is also what keeps the meaning off colour
  // alone for anyone who cannot distinguish the red.
  await expect(cell.locator("svg")).toBeVisible();
});

test("the warning counts and names every affected active location, not just the first", async ({
  page,
}) => {
  await seedLocation("E2E Kávézó Fő tér", null);
  await seedLocation("E2E Kávézó Petőfi utca", null);
  await seedLocation("E2E Kávézó Duna part", "https://g.page/r/e2e-configured-link");
  await openLocations(page);

  const warning = warningBanner(page);
  await expect(warning).toContainText("2 aktív helyszínhez nincs Google-értékelési link");
  await expect(warning).toContainText("E2E Kávézó Fő tér");
  await expect(warning).toContainText("E2E Kávézó Petőfi utca");
  // The configured one must not be dragged into the warning.
  await expect(warning).not.toContainText("E2E Kávézó Duna part");
});

test("a configured active location produces no warning at all", async ({ page }) => {
  await seedLocation("E2E Kávézó Fő tér", "https://g.page/r/e2e-configured-link");
  await openLocations(page);

  // Assert the page actually rendered BEFORE asserting an absence -- otherwise
  // toHaveCount(0) would also pass on a page that never loaded.
  await expect(page.getByRole("heading", { name: "Helyszínek" })).toBeVisible();
  // exact, because Playwright's default substring match is case-insensitive
  // and "Nincs beállítva" would satisfy a loose "Beállítva" just as happily.
  await expect(page.getByText("Beállítva", { exact: true })).toBeVisible();
  await expect(warningBanner(page)).toHaveCount(0);
});

test("an INACTIVE location with no Google review URL is deliberately not warned about", async ({
  page,
}) => {
  await seedLocation("E2E Kávézó Fő tér", null, "inactive");
  await openLocations(page);

  await expect(page.getByRole("heading", { name: "Helyszínek" })).toBeVisible();
  // The row still reports the state honestly...
  await expect(page.getByText("Nincs beállítva")).toBeVisible();
  // ...but a switched-off location collects nothing, so there is nothing to
  // act on and no banner. Without this test, "warn about every location
  // missing a URL" would pass every other test in this file.
  await expect(warningBanner(page)).toHaveCount(0);
});

/**
 * Round-14 R14-05. The warning and the badge checked raw truthiness while the
 * public CTA checked `safeGoogleReviewUrl`, so they disagreed on exactly one
 * state: a stored value the guard REJECTS. That state is reachable without any
 * exotic input -- `master`'s location action accepted any HTTP(S) URL, the
 * column carries no Google-only constraint, and nothing backfilled it. A
 * legacy `https://example.com` therefore read as "Beállítva" to the owner
 * while every customer who tapped that location's card got no button at all:
 * the precise failure F3 was written to end, surviving inside F3's own fix.
 *
 * I asked this exact question in the round-14 handoff (§ 4, "is a location
 * with a Google URL that is stored but invalid possible?") and then shipped
 * the version that gets it wrong. The predicate is now shared.
 */
test("a stored-but-invalid Google URL is warned about, not shown as configured", async ({ page }) => {
  await seedLocation("E2E Kávézó Hibás", "https://example.com/not-google");
  await openLocations(page);

  const warning = warningBanner(page);
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("E2E Kávézó Hibás");

  // Told apart from "never set one": the owner has a value, and it is the
  // wrong kind of value. Those need different actions from them.
  const cell = page.getByRole("cell", { name: "Hibás link" });
  await expect(cell).toBeVisible();
  await expect(cell.locator("svg")).toBeVisible();
  await expect(page.getByText("Beállítva", { exact: true })).toHaveCount(0);
});

test("the customer-facing CTA and the owner-facing badge never disagree", async ({ page, request }) => {
  await seedLocation("E2E Kávézó Hibás", "https://example.com/not-google");
  const admin = adminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id")
    .eq("organization_id", member.orgId)
    .single();
  const { data: card } = await admin
    .from("nfc_cards")
    .insert({
      organization_id: member.orgId,
      location_id: location!.id,
      display_name: "E2E Hibás Card",
    })
    .select("public_id")
    .single();

  // The public page: no CTA, because the guard rejects the stored value.
  const publicPage = await request.get(`/r/${card!.public_id}`);
  expect(publicPage.status()).toBe(200);
  expect(await publicPage.text()).not.toContain("Google-értékelés írása");

  // The dashboard must agree with that, which is the whole finding.
  await openLocations(page);
  await expect(page.getByText("Beállítva", { exact: true })).toHaveCount(0);
  await expect(warningBanner(page)).toBeVisible();
});
