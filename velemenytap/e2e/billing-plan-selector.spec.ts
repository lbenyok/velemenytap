import { test, expect } from "@playwright/test";
import { seedOrgWithMember, cleanupOrgWithMember, type SeededOrgMember } from "./support/seed";
import { signInViaUi } from "./support/ui";

/**
 * The plan selector must actually select.
 *
 * Reported from production: "the blue frame isn't moving when I click the other
 * subscription." It wasn't a state bug -- there was no state. Each plan was its
 * own form with its own submit button, and the yearly card carried a hardcoded
 * `border-primary` as a static "recommended" emphasis. So it looked like a
 * chooser, behaved like two buttons, and the highlight could never move.
 *
 * These tests pin the behaviour a person expects from something that looks like
 * a chooser: exactly one option selected, the highlight follows the click, and
 * one submit button rather than one per card.
 *
 * Note the settle wait: the cards use `transition-colors`, so reading the
 * border immediately after a click returns the animation's START frame. That
 * cost real time to diagnose once already -- a screenshot taken mid-transition
 * looked exactly like the bug being tested for.
 */

let member: SeededOrgMember;

test.afterEach(async () => {
  if (member) await cleanupOrgWithMember(member.userId, member.orgId);
});

const SETTLE_MS = 600;

async function borderOf(page: import("@playwright/test").Page, interval: "monthly" | "yearly") {
  return page.evaluate((v) => {
    const input = document.querySelector<HTMLInputElement>(`input[value="${v}"]`);
    const card = input!.nextElementSibling as HTMLElement;
    return getComputedStyle(card).borderColor;
  }, interval);
}

test("the highlight follows the selected plan, in both directions", async ({ page }) => {
  member = await seedOrgWithMember("plan-selector");
  await signInViaUi(page, member.email, member.password);
  await page.goto("/dashboard/billing");

  const monthly = page.locator('input[value="monthly"]');
  const yearly = page.locator('input[value="yearly"]');
  // A person clicks the card, never the sr-only radio inside it.
  const monthlyCard = page.locator('label:has(input[value="monthly"])');
  const yearlyCard = page.locator('label:has(input[value="yearly"])');

  await expect(monthly).toBeChecked();
  await expect(yearly).not.toBeChecked();
  await page.waitForTimeout(SETTLE_MS);
  const monthlySelected = await borderOf(page, "monthly");
  const monthlyUnselected = await borderOf(page, "yearly");

  // The bug: these were the same before the fix, because the highlight was
  // hardcoded to one card and nothing about it depended on the selection.
  expect(monthlySelected).not.toBe(monthlyUnselected);

  await yearlyCard.click();
  await expect(yearly).toBeChecked();
  await expect(monthly).not.toBeChecked();
  await page.waitForTimeout(SETTLE_MS);

  // The selected card now wears what the selected card wore before, and the
  // deselected one wears what the deselected one wore. Comparing against the
  // earlier readings rather than a hardcoded colour keeps this honest if the
  // palette ever changes.
  expect(await borderOf(page, "yearly")).toBe(monthlySelected);
  expect(await borderOf(page, "monthly")).toBe(monthlyUnselected);

  // And back, so this cannot pass on a selector that only ever moves one way.
  await monthlyCard.click();
  await expect(monthly).toBeChecked();
  await page.waitForTimeout(SETTLE_MS);
  expect(await borderOf(page, "monthly")).toBe(monthlySelected);
  expect(await borderOf(page, "yearly")).toBe(monthlyUnselected);
});

test("one submit button for the whole chooser, and no free-months claim", async ({ page }) => {
  member = await seedOrgWithMember("plan-chrome");
  await signInViaUi(page, member.email, member.password);
  await page.goto("/dashboard/billing");

  // Two buy buttons is what made it read as two separate offers rather than
  // one choice, and is how the old layout worked.
  await expect(page.getByRole("button", { name: "Előfizetek" })).toHaveCount(1);

  // Removed deliberately -- see the commit that added this test.
  await expect(page.getByText(/hónap ingyen/)).toHaveCount(0);

  // Both prices still have to be visible to choose between them.
  await expect(page.getByText("4990 Ft")).toBeVisible();
  await expect(page.getByText("49 900 Ft")).toBeVisible();
});
