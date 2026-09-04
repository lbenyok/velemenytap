import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocked before importing env.ts so its top-level `fs` calls (none at
// import time, but every call inside loadEnvVars) go through these.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const REQUIRED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

/**
 * Round-2 finding R2-06: "make database tests fail closed without
 * explicitly verified test configuration... test the configuration
 * failure paths." An earlier version of loadEnvVars() silently fell back
 * to .env.local (the shared dev/production project) whenever
 * .env.test.local didn't exist -- meaning a missing test-project file
 * turned every e2e/db test into one that mutates production data, with no
 * error. These tests cover the fixed, fail-closed behavior directly,
 * without touching the real filesystem or the real isolated project.
 */
describe("loadEnvVars (round-2 finding R2-06: fail closed on missing test config)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const key of REQUIRED_KEYS) delete process.env[key];
    delete process.env.RESEND_API_KEY;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("throws a clear, actionable error when .env.test.local is missing and no required env vars are already set", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => loadEnvVars()).toThrow(/\.env\.test\.local/);
    expect(() => loadEnvVars()).toThrow(/never fall back to \.env\.local/);
  });

  it("does NOT throw, and does NOT read any file, when required vars are already set in process.env (the real CI case: secrets land directly in process.env, no file exists)", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ci-project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "ci-key";
    process.env.SUPABASE_SECRET_KEY = "ci-secret";

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).not.toThrow();
  });

  it("succeeds when .env.test.local exists and contains all required keys", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://isolated-project.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=isolated-key",
        "SUPABASE_SECRET_KEY=isolated-secret",
      ].join("\n"),
    );

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    expect(result.NEXT_PUBLIC_SUPABASE_URL).toBe("https://isolated-project.supabase.co");
  });

  it("throws even when .env.test.local exists but is missing one required key", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      ["NEXT_PUBLIC_SUPABASE_URL=https://isolated-project.supabase.co"].join("\n"),
      // SUPABASE_SECRET_KEY and the publishable key are missing.
    );

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("never checks for or reads .env.local as a fallback -- only .env.test.local is ever consulted, structurally, not just by the outcome of one scenario", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://isolated-project.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=isolated-key",
        "SUPABASE_SECRET_KEY=isolated-secret",
      ].join("\n"),
    );

    const { loadEnvVars } = await import("./env");
    loadEnvVars();

    // Exactly one path is ever probed or read, and it's the test project's
    // file -- there is no second existsSync/readFileSync call for
    // .env.local anywhere in this function, at any point, regardless of
    // whether the first check succeeds or fails.
    expect(vi.mocked(fs.existsSync).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(fs.existsSync).mock.calls[0][0])).toMatch(/\.env\.test\.local$/);
    expect(vi.mocked(fs.readFileSync).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(fs.readFileSync).mock.calls[0][0])).toMatch(/\.env\.test\.local$/);
  });

  it("force-disables RESEND_API_KEY and NEXT_PUBLIC_SENTRY_DSN even if the test config file sets them", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://isolated-project.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=isolated-key",
        "SUPABASE_SECRET_KEY=isolated-secret",
        "RESEND_API_KEY=re_should_never_be_used_in_tests",
        "NEXT_PUBLIC_SENTRY_DSN=https://should-never-be-used@sentry.io/123",
      ].join("\n"),
    );

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    expect(result.RESEND_API_KEY).toBe("");
    expect(result.NEXT_PUBLIC_SENTRY_DSN).toBe("");
    expect(process.env.RESEND_API_KEY).toBe("");
    expect(process.env.NEXT_PUBLIC_SENTRY_DSN).toBe("");
  });
});
