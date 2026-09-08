import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Round-4 finding R4-01: /api/health must fail loud (non-200, ok: false)
 * when release metadata (VERCEL_GIT_COMMIT_SHA) is missing in a
 * production/preview environment -- silently reporting success there is
 * exactly the class of gap that let production run stale, unverified code
 * without anything noticing. Locally (no Vercel involved), a missing
 * commit SHA is normal and must not be flagged as an error.
 *
 * Round-6 finding R6-06: round 5's fix (R5-05) computed "is this a
 * deployed environment" from a BUILD-TIME snapshot of VERCEL_ENV, on the
 * theory that Vercel's build step always has it available regardless of
 * the "Automatically expose System Environment Variables" toggle. That
 * theory is wrong per Vercel's own current docs -- VERCEL_ENV is gated by
 * that exact toggle at both build and runtime, no carve-out. Rewritten to
 * never depend on any Vercel-managed variable for the fail-closed
 * decision: APP_ENV is a plain, non-system environment variable the owner
 * sets directly per Vercel environment (immune to that toggle by
 * construction), and "local dev" is decided from NODE_ENV. These tests
 * mock lib/build-info (unrelated now -- it only carries migration info)
 * and drive process.env directly.
 *
 * Round-7 finding R7-07: "local dev" used to be `NODE_ENV !== "production"`
 * -- fail-OPEN, since an unset, malformed, or unexpected value ("test",
 * "staging", undefined) also fell through to "development, ok: true"
 * rather than to the strict checks below. Flipped to fail-CLOSED:
 * `NODE_ENV === "development"` (the one value `next dev` itself actually
 * sets) is the only value treated as local dev; everything else --
 * missing, malformed, "test", or anything else -- is now a production-
 * mode check requiring APP_ENV/commitSha the same as a genuine deployment
 * would. The matrix below exercises development, production, "test",
 * missing NODE_ENV, and a malformed NODE_ENV value explicitly, crossed
 * with valid/missing APP_ENV and valid/missing commit SHA.
 */
vi.mock("@/lib/build-info", () => ({
  LATEST_MIGRATION: "20260101000000_test.sql",
  MIGRATION_COUNT: 1,
}));

describe("GET /api/health", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.APP_ENV;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllEnvs();
  });

  describe('local development -- NODE_ENV === "development" only', () => {
    it("reports ok locally with no APP_ENV and no commit SHA at all", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe("development");
      expect(body.commitSha).toBeNull();
      expect(body.error).toBeUndefined();
    });

    it("reports ok locally even if a stray VERCEL_ENV is somehow set -- that variable is never trusted", async () => {
      vi.stubEnv("NODE_ENV", "development");
      process.env.VERCEL_ENV = "production";
      const { GET } = await import("./route");
      const res = await GET();
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe("development");
    });
  });

  /**
   * Round-7 finding R7-07's actual regression case: NODE_ENV values other
   * than exactly "production" used to be silently treated as safe local
   * development. "test" is vitest's own default NODE_ENV, and is exactly
   * the kind of value that must now be treated strictly, not leniently.
   */
  describe('NODE_ENV="test" is now strict (production-mode), not local dev', () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "test");
    });

    it("fails loud when APP_ENV is not set, even though NODE_ENV is merely 'test'", async () => {
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.environment).toBe("unknown");
    });

    it("reports ok when APP_ENV and a commit SHA are both genuinely present", async () => {
      process.env.APP_ENV = "preview";
      process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("MISSING NODE_ENV entirely is also strict, not local dev", () => {
    beforeEach(() => {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    });

    it("fails loud when APP_ENV is not set", async () => {
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("reports ok when APP_ENV and a commit SHA are both present", async () => {
      process.env.APP_ENV = "production";
      process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("a MALFORMED NODE_ENV value is also strict, not local dev", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "developmnet"); // typo'd, not the real value
    });

    it("fails loud when APP_ENV is not set", async () => {
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  describe("production-mode builds (NODE_ENV === production)", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("MISSING metadata: fails loud when APP_ENV is not set at all, even with no other signal either way", async () => {
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.environment).toBe("unknown");
      expect(body.error).toContain("APP_ENV");
      expect(body.error).toContain("not set");
    });

    it("MALFORMED metadata: fails loud when APP_ENV is set to an unrecognized value", async () => {
      process.env.APP_ENV = "prod";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('"prod"');
    });

    it("does NOT fall back to a stale/toggle-gated VERCEL_ENV when APP_ENV is missing -- this is the exact R6-06 regression", async () => {
      // The old (R5-05) logic would have read this as a healthy deploy;
      // APP_ENV is what must now be authoritative, and it's absent here.
      process.env.VERCEL_ENV = "production";
      process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("PRODUCTION: reports ok when APP_ENV=production and a commit SHA is present", async () => {
      process.env.APP_ENV = "production";
      process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe("production");
      expect(body.commitSha).toBe("abc123");
    });

    it("PRODUCTION: fails loud when APP_ENV=production but the commit SHA is missing (the disabled-toggle case)", async () => {
      process.env.APP_ENV = "production";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("VERCEL_GIT_COMMIT_SHA");
    });

    it("PREVIEW: reports ok when APP_ENV=preview and a commit SHA is present", async () => {
      process.env.APP_ENV = "preview";
      process.env.VERCEL_GIT_COMMIT_SHA = "def456";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.environment).toBe("preview");
    });

    it("PREVIEW: fails loud when APP_ENV=preview but the commit SHA is missing, same as production", async () => {
      process.env.APP_ENV = "preview";
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("reports the build's expected latest migration regardless of ok/environment status", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(typeof body.latestMigration).toBe("string");
    expect(body.migrationCount).toBeGreaterThan(0);
  });
});
