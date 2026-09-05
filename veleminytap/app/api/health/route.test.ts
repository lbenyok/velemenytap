import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Round-4 finding R4-01: /api/health must fail loud (non-200, ok: false)
 * when release metadata (VERCEL_GIT_COMMIT_SHA) is missing in a
 * production/preview environment -- silently reporting success there is
 * exactly the class of gap that let production run stale, unverified code
 * without anything noticing. Locally (no Vercel involved), a missing
 * commit SHA is normal and must not be flagged as an error.
 *
 * Round-5 finding R5-05: "is this a deployed environment" used to be
 * decided from process.env.VERCEL_ENV -- the same runtime variable a
 * disabled "Automatically expose System Environment Variables" toggle
 * also suppresses, so that exact misconfiguration read as a harmless
 * "development"/ok:true instead of the failure it actually is.
 * BUILD_VERCEL_ENV (lib/build-info.ts, mocked below) is captured at BUILD
 * time, when Vercel always exposes it regardless of that toggle -- these
 * tests control it independently of the runtime env vars to prove the
 * fix actually closes that gap, not just move it.
 */
let mockBuildVercelEnv: string | null = null;

vi.mock("@/lib/build-info", () => ({
  LATEST_MIGRATION: "20260101000000_test.sql",
  MIGRATION_COUNT: 1,
  get BUILD_VERCEL_ENV() {
    return mockBuildVercelEnv;
  },
}));

describe("GET /api/health", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockBuildVercelEnv = null;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_REF;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reports ok locally (not a Vercel build at all) even with no commit SHA", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.environment).toBe("development");
    expect(body.commitSha).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it("reports ok in production when a commit SHA is present", async () => {
    mockBuildVercelEnv = "production";
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commitSha).toBe("abc123");
  });

  it("fails loud (503, ok: false) in production with no commit SHA", async () => {
    mockBuildVercelEnv = "production";
    process.env.VERCEL_ENV = "production";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("VERCEL_GIT_COMMIT_SHA");
  });

  it("fails loud in preview with no commit SHA too, not just production", async () => {
    mockBuildVercelEnv = "preview";
    process.env.VERCEL_ENV = "preview";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("R5-05 regression: still fails loud when the runtime-exposure toggle hides BOTH VERCEL_ENV and the commit SHA, as long as this build genuinely was made on Vercel", async () => {
    // The actual bug: a disabled "Automatically expose System Environment
    // Variables" toggle wipes out process.env.VERCEL_ENV at runtime too,
    // not just the commit SHA -- the old logic used that same suppressed
    // variable to decide whether release metadata was even expected, so
    // the whole check silently no-opped. BUILD_VERCEL_ENV is captured at
    // build time and can't be suppressed by this same runtime toggle.
    mockBuildVercelEnv = "production";
    // Deliberately NOT setting process.env.VERCEL_ENV or
    // VERCEL_GIT_COMMIT_SHA -- this is the disabled-toggle runtime state.
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("BUILD_VERCEL_ENV");
  });

  it("reports the build's expected latest migration", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(typeof body.latestMigration).toBe("string");
    expect(body.migrationCount).toBeGreaterThan(0);
  });
});
