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

// The one project this suite is allowed to resolve to -- must match
// env.ts's own APPROVED_TEST_PROJECT_REF exactly, since these tests
// exercise the real validation logic, not a mock of it.
const APPROVED_URL = "https://nowcuhwgeerzqlpweyxj.supabase.co";
// The real production project's URL (from .env.local) -- used to prove the
// validation actually rejects the specific project this suite must never
// run against, not just an arbitrary wrong string.
const PRODUCTION_URL = "https://jvssnpvrcwjxldfeddnw.supabase.co";

function fileContents(overrides: Partial<Record<string, string>> = {}): string {
  const vars: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: APPROVED_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "isolated-key",
    SUPABASE_SECRET_KEY: "isolated-secret",
    ...overrides,
  };
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function setProcessEnv(overrides: Partial<Record<string, string>> = {}) {
  const vars: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: APPROVED_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "ci-key",
    SUPABASE_SECRET_KEY: "ci-secret",
    ...overrides,
  };
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

/**
 * Round-2 finding R2-06: "make database tests fail closed without
 * explicitly verified test configuration... test the configuration
 * failure paths." Round-3 finding R3-01: the fail-closed check alone
 * wasn't enough -- a per-key "is this in the file OR process.env" test
 * could pass while still returning an object silently missing keys (the
 * real bug that broke CI's globalSetup), and credential *presence* was
 * never actually validated as being the *right* project. These tests cover
 * both the original fail-closed behavior and the round-3 single-source /
 * project-identity fixes, without touching the real filesystem or the real
 * isolated project.
 */
describe("loadEnvVars", () => {
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

  it("(R3-01) resolves correctly from process.env alone -- the real CI case: secrets land directly in process.env, no file exists in the checkout", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    setProcessEnv();

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    expect(result.NEXT_PUBLIC_SUPABASE_URL).toBe(APPROVED_URL);
    expect(result.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("ci-key");
    expect(result.SUPABASE_SECRET_KEY).toBe("ci-secret");
  });

  it("(R3-01) resolves correctly from .env.test.local alone -- the local dev case, nothing pre-set in process.env", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(fileContents());

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    expect(result.NEXT_PUBLIC_SUPABASE_URL).toBe(APPROVED_URL);
    expect(result.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("isolated-key");
    expect(result.SUPABASE_SECRET_KEY).toBe("isolated-secret");
  });

  it("(R3-01) prefers a complete file over a complete-but-different process.env, and does not blend them", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(fileContents());
    // A fully-populated, DIFFERENT-valued process.env -- e.g. a developer's
    // shell still exporting an old value from something else entirely.
    setProcessEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "stale-shell-key" });

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    // The file's value wins outright -- not a mix of the two.
    expect(result.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("isolated-key");
    // And process.env itself is overwritten to match -- so any other code
    // in this same process (e2e/support/seed.ts's adminClient(), for
    // instance) that reads process.env directly sees the resolved value,
    // not the stale one that was there before this call.
    expect(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("isolated-key");
  });

  it("(R3-01) rejects a partial file combined with a partial process.env, rather than silently combining them", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // File has only the URL.
    vi.mocked(fs.readFileSync).mockReturnValue(`NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`);
    // process.env separately has only the other two -- together they'd form
    // a complete set, but from two different, uncoordinated places.
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "ci-key";
    process.env.SUPABASE_SECRET_KEY = "ci-secret";

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/refuses to combine a partial file with a partial process environment/);
  });

  it("throws even when .env.test.local exists but is missing one required key, and nothing fills the gap from process.env", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [`NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`].join("\n"),
      // SUPABASE_SECRET_KEY and the publishable key are missing, and not
      // set in process.env either.
    );

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("(R3-01) rejects the real production project even with an otherwise complete, well-formed credential set", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(fileContents({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL }));

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/does not resolve to the approved isolated e2e test project/);
  });

  it("(R3-01) rejects any unrecognized project, not just the specific production one", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      fileContents({ NEXT_PUBLIC_SUPABASE_URL: "https://some-other-project.supabase.co" }),
    );

    const { loadEnvVars } = await import("./env");
    expect(() => loadEnvVars()).toThrow(/does not resolve to the approved isolated e2e test project/);
  });

  it("never checks for or reads .env.local as a fallback -- only .env.test.local is ever consulted, structurally, not just by the outcome of one scenario", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(fileContents());

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
      fileContents({
        RESEND_API_KEY: "re_should_never_be_used_in_tests",
        NEXT_PUBLIC_SENTRY_DSN: "https://should-never-be-used@sentry.io/123",
      }),
    );

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();
    expect(result.RESEND_API_KEY).toBe("");
    expect(result.NEXT_PUBLIC_SENTRY_DSN).toBe("");
    expect(process.env.RESEND_API_KEY).toBe("");
    expect(process.env.NEXT_PUBLIC_SENTRY_DSN).toBe("");
  });

  it("(R3-01) the spawned server and this process's own fixtures end up with identical values -- the returned object and process.env agree on every required key", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(fileContents());

    const { loadEnvVars } = await import("./env");
    const result = loadEnvVars();

    // playwright.config.ts passes this same returned object as
    // webServer.env (what the spawned next dev/start process gets);
    // e2e/support/seed.ts's adminClient()/userClient() read process.env
    // directly instead (what this process's own fixtures get). Both must
    // resolve to the identical project, which this proves by checking the
    // literal values agree, not just that both are "truthy".
    for (const key of REQUIRED_KEYS) {
      expect(process.env[key]).toBe(result[key]);
    }
  });
});
