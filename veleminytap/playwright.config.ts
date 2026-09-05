import { defineConfig, devices } from "@playwright/test";
import { loadEnvVars } from "./e2e/support/env";

// Overrides the spawned `next dev`/`next start` process's env before Next's
// own .env.local loading runs -- Next never overwrites a var that's already
// set in the process environment, so this is what makes the actual server
// under test talk to the isolated e2e Supabase project (.env.test.local)
// instead of whatever .env.local points at. loadEnvVars() throws if that
// isolated project isn't configured, rather than silently falling back to
// .env.local (round-2 finding R2-06) -- see e2e/support/env.ts.
const testEnv = loadEnvVars();

export default defineConfig({
  testDir: "./e2e",
  // Only *.spec.ts -- Playwright's own default testMatch also picks up
  // *.test.ts, which collides with this project's convention (Playwright
  // specs vs. plain Vitest units, e.g. e2e/support/env.test.ts, both live
  // under e2e/support/). Without this, Playwright tries to execute a
  // Vitest unit test file directly and fails on its vi.mock() calls.
  testMatch: "**/*.spec.ts",
  // Verifies the server under test (freshly started or reused, see
  // reuseExistingServer below) is actually configured for the isolated
  // test project before any test runs -- round-2 finding R2-06, "cannot
  // reuse an unverified running server."
  globalSetup: "./e2e/support/verify-server-config.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // In CI, run against a production build (npm run build is a separate
    // workflow step) -- next start comes up in a second or two, versus
    // next dev's Turbopack cold-start which timed out against Playwright's
    // webServer wait on a GitHub-hosted runner (see the run this replaced:
    // https://github.com/lbenyok/velemenytap/actions/runs/33796244231).
    // Piping stdout/stderr means a future startup failure is visible in
    // the CI log instead of just "timed out waiting".
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: "http://localhost:3000",
    // Reused locally rather than always cold-starting, for iteration
    // speed -- safe specifically because globalSetup (above) independently
    // verifies whatever server actually ends up under test, freshly
    // started or reused, is configured for the isolated project before any
    // test runs. Without that check, reuse would be the R2-06 risk itself:
    // a stray dev server from another terminal, started with whatever
    // .env.local says, silently becoming the server every test drives.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: testEnv,
  },
});
