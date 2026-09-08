import { test, expect } from "@playwright/test";
import { seedReviewGatingOrg, cleanupOrg, type SeededOrg } from "./support/seed";

/**
 * The Review-Gating Regression Test from the product skill, automated: the
 * Google Review CTA must be available after every rating from 1 to 5,
 * identically. This is the single most important invariant in the product
 * (see PRODUCT_SPEC.md "The one rule that overrides everything else") --
 * this suite is what makes that a checked fact instead of a manual step.
 */

let seeded: SeededOrg;

test.beforeAll(async () => {
  seeded = await seedReviewGatingOrg();
});

test.afterAll(async () => {
  await cleanupOrg(seeded.orgId);
});

for (const rating of [1, 2, 3, 4, 5] as const) {
  test(`rating ${rating} -> Google Review CTA is available`, async ({ page }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!;
    await page.goto(`/r/${card.publicId}`);

    await page.getByRole("radio", { name: new RegExp(`^${rating} csillag —`) }).click();

    await page.getByRole("button", { name: "Vélemény küldése" }).click();

    await expect(page.getByRole("heading", { name: "Köszönjük!" })).toBeVisible();

    const cta = page.getByRole("link", { name: "Google-értékelés írása" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "https://g.page/r/e2e-test-review-link");
  });
}

test("duplicate submission on the same card is rejected, not silently double-counted", async ({
  page,
}) => {
  const card = seeded.cards.find((c) => c.rating === 5)!;
  await page.goto(`/r/${card.publicId}`);
  await page.getByRole("radio", { name: /^5 csillag —/ }).click();
  await page.getByRole("button", { name: "Vélemény küldése" }).click();
  await expect(page.getByRole("heading", { name: "Köszönjük!" })).toBeVisible();

  // Same browser context/cookies, same card, a second tap.
  await page.goto(`/r/${card.publicId}`);
  await page.getByRole("radio", { name: /^5 csillag —/ }).click();
  await page.getByRole("button", { name: "Vélemény küldése" }).click();

  await expect(page.getByText("Ehhez a látogatáshoz már küldtél véleményt.")).toBeVisible();
});
