import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  generateConfirmToken,
  type SeededOrgMember,
} from "./support/seed";

/**
 * Confirms the fix for the open-redirect finding (review finding #5) against
 * a real browser's URL resolution, not just Node's. A backslash variant like
 * "/\evil.example.com" passes a naive `startsWith("/") &&
 * !startsWith("//")` check yet a browser parses it identically to
 * "//evil.example.com" -- see lib/safe-redirect.ts and its unit tests for
 * the full explanation. Both call sites (features/auth/actions.ts's
 * signInAction and app/auth/confirm/route.ts) share the same
 * safeRedirectTarget() helper; this suite drives each end-to-end.
 */

// beforeEach/afterEach, not beforeAll/afterAll: Playwright runs file-level
// beforeAll/afterAll once PER WORKER when a file's tests are distributed
// across multiple parallel workers (the default here), not once per file --
// so a shared `user` fixture would get independently (and concurrently)
// re-seeded by every worker that picks up any test from this file. Each
// test gets its own isolated user/org instead.
let user: SeededOrgMember;

test.beforeEach(async () => {
  user = await seedOrgWithMember("redirect-safety");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(user.userId, user.orgId);
});

async function signIn(page: import("@playwright/test").Page) {
  await page.getByLabel("E-mail cím").fill(user.email);
  await page.getByLabel("Jelszó").fill(user.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
}

test("login: a backslash-variant next param does not escape the site", async ({ page }) => {
  await page.goto("/login?next=" + encodeURIComponent("/\\evil.example.com"));
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
});

test("login: a legitimate next param is honored", async ({ page }) => {
  await page.goto("/login?next=" + encodeURIComponent("/dashboard/feedback"));
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard\/feedback$/);
});

test("login: an absolute external next param falls back to the dashboard", async ({ page }) => {
  await page.goto("/login?next=" + encodeURIComponent("https://evil.example.com/phish"));
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
});

test("email confirmation: a backslash-variant next param does not escape the site", async ({
  page,
}) => {
  const { tokenHash } = await generateConfirmToken(user.email);
  const next = encodeURIComponent("/\\evil.example.com");
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=${next}`);

  await expect(page).toHaveURL(/\/dashboard$/);
});

// Round 2 (R2-01): a dot-segment ("..") in the next param can produce a
// pathname starting with "//" -- itself a protocol-relative reference --
// even though the *candidate* parses same-origin. If the site actually
// navigated off-origin here, evil.example doesn't resolve in this test
// environment, so the browser would be left on a failed navigation
// (net::ERR_NAME_NOT_RESOLVED), never landing on /dashboard -- this
// assertion fails loudly either way, not silently.
test("login: a dot-segment next param producing a double-slash pathname does not escape the site", async ({
  page,
}) => {
  await page.goto("/login?next=" + encodeURIComponent("/a/..//evil.example/path"));
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
});

test("login: a same-origin absolute URL with a double-slash pathname does not escape the site", async ({
  page,
}) => {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  await page.goto("/login?next=" + encodeURIComponent(`${siteUrl}//evil.example/path`));
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
});

test("email confirmation: a dot-segment next param producing a double-slash pathname does not escape the site", async ({
  page,
}) => {
  const { tokenHash } = await generateConfirmToken(user.email);
  const next = encodeURIComponent("/a/..//evil.example/path");
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=${next}`);

  await expect(page).toHaveURL(/\/dashboard$/);
});
