import { loadEnvVars } from "./env";

/**
 * Playwright global setup (round-2 finding R2-06): "cannot reuse an
 * unverified running server." playwright.config.ts's webServer can reuse
 * an already-running `next dev` locally rather than starting a fresh one
 * (reuseExistingServer) -- a real, previously-observed risk in this
 * project: a stray dev server left running from another terminal, started
 * with whatever .env.local says (the shared dev/production project), would
 * silently become "the server under test" while every test fixture
 * (seedOrgWithMember, adminClient, etc.) talks to the isolated test
 * project instead. Every assertion in the suite would then be checking a
 * server that can never agree with its own fixtures -- confusing failures
 * at best, unintended interaction with production at worst.
 *
 * Fetches app/api/e2e-config-check (returns only the already-public
 * NEXT_PUBLIC_SUPABASE_URL) once the server is reachable, and fails the
 * entire run immediately, with a specific and actionable error, if it
 * doesn't match the isolated project the test fixtures are configured for
 * -- whether that server was freshly started by Playwright or reused from
 * an existing process.
 */
export default async function globalSetup(): Promise<void> {
  const expectedUrl = loadEnvVars().NEXT_PUBLIC_SUPABASE_URL;

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://localhost:3000/api/e2e-config-check");
      if (!response.ok) {
        throw new Error(`e2e-config-check responded ${response.status}`);
      }
      const { supabaseUrl } = (await response.json()) as { supabaseUrl: string | null };

      if (supabaseUrl !== expectedUrl) {
        throw new Error(
          `The server under test at http://localhost:3000 is configured for Supabase project ` +
            `"${supabaseUrl}", but the test fixtures (.env.test.local) expect "${expectedUrl}". ` +
            "This is very likely a stray `npm run dev`/`npm run start` left running from another " +
            "terminal, started without the isolated test project's env -- stop it and re-run, " +
            "or restart it via `npm run test:e2e` so Playwright starts it with the right " +
            "environment. Refusing to run any test against a server that can't be confirmed to " +
            "match its own fixtures.",
        );
      }
      return;
    } catch (err) {
      lastError = err;
      // A connection error (server not up yet) is expected early in the
      // wait window and worth retrying; a genuine mismatch (thrown above)
      // is also retried here for simplicity, but will keep failing with
      // the same clear message until the deadline, which is exactly the
      // outcome that should surface.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not verify the server under test's Supabase project configuration.");
}
