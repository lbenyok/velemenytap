import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  type SeededOrgMember,
} from "./support/seed";

/**
 * Round-4 findings R4-05 (no accessible names below `lg`) and R4-06
 * (header cannot fit mobile widths). The dashboard nav now shows every
 * link's icon AND label at >= md width, and collapses into a labelled
 * menu button opening a full-label side panel below it -- both states
 * verified directly here, at the four widths the finding named.
 */

const VIEWPORTS = {
  narrow320: { width: 320, height: 720 },
  narrow375: { width: 375, height: 720 },
  tablet768: { width: 768, height: 900 },
  desktop: { width: 1280, height: 900 },
} as const;

const NAV_LABELS = [
  "Áttekintés",
  "Helyszínek",
  "NFC kártyák",
  "Vélemények",
  "Elemzés",
  "Beállítások",
];

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("nav-a11y");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);
}

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "page should not overflow horizontally").toBe(false);
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`R4-06: no horizontal overflow at ${name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    await assertNoHorizontalOverflow(page);
  });
}

test("R4-05: every nav link has a visible accessible name at desktop width", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await signIn(page);

  const nav = page.getByRole("navigation", { name: "Irányítópult navigáció" });
  for (const label of NAV_LABELS) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
});

test("R4-05: the current route is exposed via aria-current on desktop", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await signIn(page);

  await expect(page.getByRole("link", { name: "Áttekintés" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "Helyszínek" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByRole("link", { name: "Helyszínek" }).click();
  await page.waitForURL(/\/dashboard\/locations$/);
  await expect(page.getByRole("link", { name: "Helyszínek" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("R4-06: below md, the inline nav is hidden and a labelled menu button reveals every link with a visible name", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.narrow375);
  await signIn(page);

  // The desktop inline nav must not be present/visible at this width --
  // otherwise it's exactly the R4-06 overflow this fix is for.
  await expect(page.getByRole("link", { name: "Helyszínek" })).toHaveCount(0);

  const menuButton = page.getByRole("button", { name: "Menü megnyitása" });
  await expect(menuButton).toBeVisible();

  await menuButton.click();
  const menu = page.getByRole("navigation", { name: "Irányítópult navigáció" });
  for (const label of NAV_LABELS) {
    await expect(menu.getByRole("link", { name: label })).toBeVisible();
  }
});

test("R4-06: Escape closes the mobile menu, and it is keyboard-operable", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.narrow375);
  await signIn(page);

  const menuButton = page.getByRole("button", { name: "Menü megnyitása" });
  const nav = page.getByRole("navigation", { name: "Irányítópult navigáció" });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  // Overview's own "Elemzés megtekintése" link elsewhere on the page also
  // substring-matches "Elemzés" -- scope to the menu's own nav landmark.
  await expect(nav.getByRole("link", { name: "Elemzés", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
});

test("R4-06: choosing a link in the mobile menu navigates and closes it", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.narrow375);
  await signIn(page);

  await page.getByRole("button", { name: "Menü megnyitása" }).click();
  await page.getByRole("navigation", { name: "Irányítópult navigáció" }).getByRole("link", { name: "Vélemények" }).click();
  await page.waitForURL(/\/dashboard\/feedback$/);
  await expect(page.getByRole("link", { name: "Vélemények" })).toBeHidden();
});

test("R4-06: sign-out remains reachable by accessible name at every viewport", async ({ page }) => {
  await signIn(page);
  for (const viewport of Object.values(VIEWPORTS)) {
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Kijelentkezés" })).toBeVisible();
  }
});
