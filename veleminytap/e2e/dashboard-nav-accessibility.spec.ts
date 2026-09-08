import { test, expect, type Page } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  type SeededOrgMember,
} from "./support/seed";
import { signInViaUi } from "./support/ui";

/**
 * Round-4 findings R4-05 (no accessible names below `lg`) and R4-06
 * (header cannot fit mobile widths). The dashboard nav now shows every
 * link's icon AND label at >= 2xl width, and collapses into a labelled
 * menu button opening a full-label side panel below it.
 *
 * Found during an independent review, after billing added a seventh nav
 * link: this file's own `assertNoHorizontalOverflow` (scrollWidth vs.
 * clientWidth) never actually detects the failure mode this section is
 * for. Flexbox doesn't clip an overflowing sibling by default, so two
 * elements can visually overlap -- rendered on top of each other -- with
 * zero effect on the document's scrollable width; this was already true
 * of the exact bug R5-07 fixed (see dashboard-nav.tsx's own comment), and
 * it's exactly what let the seventh link's overlap at 1280px ship
 * unnoticed: `document.documentElement.scrollWidth` reported 1280,
 * identical to `clientWidth`, while the nav's own right edge
 * (getBoundingClientRect) sat at x=967.5 and the org name's left edge sat
 * at x=942.7 -- a real, visible ~25px overlap the old assertion could
 * never have caught at any width. `assertNoOverlap` below checks real
 * element bounding boxes instead, and is run at and above the actual
 * breakpoint (2xl/1536px) where the inline nav can even be present, not
 * just the one width the previous version of this file happened to
 * check.
 */

const VIEWPORTS = {
  narrow320: { width: 320, height: 720 },
  narrow375: { width: 375, height: 720 },
  tablet768: { width: 768, height: 900 },
  // Below the 2xl breakpoint -- the mobile Sheet menu renders here, not
  // the inline nav, so there is nothing for it to overlap. Kept as a
  // named viewport specifically because it's the width the previous
  // (2xl-unaware) version of this file called "desktop" and where the
  // billing link's overlap was first found -- worth a permanent
  // regression check that it stays the Sheet-menu case, not silently
  // becoming the inline-nav case again if the breakpoint is ever changed.
  laptop1280: { width: 1280, height: 900 },
  // The actual breakpoint the inline nav appears at (dashboard-nav.tsx's
  // own comment has the real measurements behind this specific value).
  desktop: { width: 1536, height: 900 },
} as const;

// Widths at and above the 2xl breakpoint, where the inline desktop nav is
// actually present and could actually overlap something -- "1280px and
// nearby widths" from a bounding-box-overlap perspective now means widths
// near the REAL boundary (1536), not the old, no-longer-relevant one.
const OVERLAP_CHECK_WIDTHS = [1536, 1600, 1920] as const;

const NAV_LABELS = [
  "Áttekintés",
  "Helyszínek",
  "NFC kártyák",
  "Vélemények",
  "Elemzés",
  "Számlázás",
  "Beállítások",
];

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("nav-a11y");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

async function signIn(page: Page) {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL(/\/dashboard$/);
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "page should not overflow horizontally").toBe(false);
}

/**
 * Real bounding-box overlap check between the desktop nav's own rightmost
 * extent and the header's right-hand cluster (org name, tour-reopen
 * button, sign-out button) -- the actual failure mode found this round,
 * which `assertNoHorizontalOverflow` above structurally cannot detect
 * (see this file's own top comment). Fails loudly with the exact pixel
 * values on a genuine overlap or a suspiciously thin margin, rather than
 * a bare boolean, so a future regression's own failure message is
 * immediately actionable without having to re-instrument the check.
 */
async function assertNoNavOverlap(page: Page, minimumGapPx = 8) {
  const nav = page.getByRole("navigation", { name: "Irányítópult navigáció" }).first();
  const header = page.locator("header");

  const navBox = await nav.boundingBox();
  expect(navBox, "the inline desktop nav should be present and rendered at this width").not.toBeNull();

  // The right-hand cluster is whichever of these three elements has the
  // leftmost edge -- comparing against all three (not just the org name)
  // means a future header restyle that reorders or resizes this cluster
  // still gets checked against whatever actually ends up leftmost. The
  // org name itself (app/dashboard/layout.tsx's `truncate` span) is the
  // one that actually collided in the incident this test is for -- it's
  // the closest of the three to the nav, so it's the first to overlap.
  const candidates = await Promise.all([
    header.locator("span.truncate").first().boundingBox().catch(() => null),
    page.getByRole("button", { name: "Útmutató megnyitása" }).boundingBox().catch(() => null),
    page.getByRole("button", { name: "Kijelentkezés" }).boundingBox().catch(() => null),
  ]);
  const rightClusterLefts = candidates.filter((box): box is NonNullable<typeof box> => box !== null).map((box) => box.x);
  expect(rightClusterLefts.length, "expected at least one right-hand header element to be present").toBeGreaterThan(0);

  const navRight = navBox!.x + navBox!.width;
  const clusterLeft = Math.min(...rightClusterLefts);
  const gap = clusterLeft - navRight;

  expect(
    gap,
    `nav's right edge (x=${navRight.toFixed(1)}) vs. the header's right-hand cluster (x=${clusterLeft.toFixed(1)}) -- gap of ${gap.toFixed(1)}px, need >= ${minimumGapPx}px`,
  ).toBeGreaterThanOrEqual(minimumGapPx);
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`R4-06: no horizontal overflow at ${name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    await assertNoHorizontalOverflow(page);
  });
}

/**
 * Found during an independent review: the previous scrollWidth-only check
 * passed at 1280px even with a real ~25px visible overlap between the nav
 * and the org name once billing added a seventh link -- these tests are
 * the direct fix, using real bounding boxes at and above the actual
 * breakpoint where the inline nav is present.
 */
for (const width of OVERLAP_CHECK_WIDTHS) {
  test(`the desktop nav never overlaps the header's right-hand cluster at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await assertNoNavOverlap(page);
  });
}

test("below the 2xl breakpoint (1280px), the inline nav is absent entirely -- nothing for it to overlap, and the Sheet menu is what actually renders", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.laptop1280);
  await signIn(page);

  await expect(page.getByRole("link", { name: "Helyszínek" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menü megnyitása" })).toBeVisible();
});

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
