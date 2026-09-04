import { test, expect } from "@playwright/test";
import {
  seedAuthUser,
  cleanupAuthUser,
  generateConfirmToken,
  type SeededAuthUser,
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

let user: SeededAuthUser;

test.beforeAll(async () => {
  user = await seedAuthUser();
});

test.afterAll(async () => {
  await cleanupAuthUser(user.userId);
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
