import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Round-4 finding R4-01: /api/health must fail loud (non-200, ok: false)
 * when release metadata (VERCEL_GIT_COMMIT_SHA) is missing in a
 * production/preview environment -- silently reporting success there is
 * exactly the class of gap that let production run stale, unverified code
 * without anything noticing. Locally (no VERCEL_ENV), a missing commit SHA
 * is normal and must not be flagged as an error.
 */
describe("GET /api/health", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_REF;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reports ok locally (no VERCEL_ENV) even with no commit SHA", async () => {
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
    process.env.VERCEL_ENV = "production";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("VERCEL_GIT_COMMIT_SHA");
  });

  it("fails loud in preview with no commit SHA too, not just production", async () => {
    process.env.VERCEL_ENV = "preview";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("reports the build's expected latest migration", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(typeof body.latestMigration).toBe("string");
    expect(body.migrationCount).toBeGreaterThan(0);
  });
});
