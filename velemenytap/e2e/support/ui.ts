import type { Page } from "@playwright/test";

/**
 * Fourth independent review (mandatory testing item): "Fix the e2e
 * authentication setup so a normal complete run does not routinely
 * produce dozens of rate-limit failures." Supabase Auth's rate limiter is
 * shared across the whole isolated project, not something this app's code
 * controls -- a large, fully-parallel Playwright run genuinely collides
 * with it. Every UI-driven sign-in across the suite previously duplicated
 * its own fill+click block with no retry; this is the one place that
 * logic now lives, mirroring the retry-with-backoff already added to
 * e2e/support/seed.ts's userClient() for the API-level sign-in path.
 *
 * The retry decision is made by reading the actual server-reported error
 * text (features/auth/actions.ts's translateAuthError -- rate limits are
 * the only path that produces this exact Hungarian wording), never by
 * guessing from timing. A real auth failure (wrong password, etc.) is
 * thrown immediately rather than silently retried.
 */
const RATE_LIMIT_TEXT = /Túl sok próbálkozás/;

export async function submitLoginForm(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByLabel("E-mail cím").fill(email);
    await page.getByLabel("Jelszó").fill(password);
    await page.getByRole("button", { name: "Bejelentkezés" }).click();

    const navigatedAway = await page
      .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (navigatedAway) return;

    const rateLimited = await page.getByText(RATE_LIMIT_TEXT).isVisible();
    if (rateLimited && attempt < 4) {
      // Exponential backoff (500ms, 1s, 2s, 4s) -- gives the rate
      // limiter's own window a real chance to recover.
      await page.waitForTimeout(500 * 2 ** attempt);
      continue;
    }
    if (rateLimited) {
      throw new Error(
        `submitLoginForm: still rate-limited after ${attempt + 1} attempts signing in as ${email}`,
      );
    }
    throw new Error(
      `submitLoginForm: sign-in for ${email} did not navigate away from /login and did not show the rate-limit message -- a real auth failure, not a rate limit`,
    );
  }
}

export async function signInViaUi(
  page: Page,
  email: string,
  password: string,
  next?: string,
): Promise<void> {
  const url = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  await page.goto(url);
  await submitLoginForm(page, email, password);
}
