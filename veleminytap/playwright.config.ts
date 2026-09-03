import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
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
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
