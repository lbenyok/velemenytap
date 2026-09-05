import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { projectRefFromDbUrl } from "./db-connection";

const mockConnect = vi.fn();
vi.mock("pg", () => ({
  // A real class, not a vi.fn() returning an object literal -- `new` on a
  // mocked arrow-function implementation isn't a valid constructor call.
  Client: class {
    connect() {
      return mockConnect();
    }
    end() {
      return Promise.resolve();
    }
  },
}));

const APPROVED_URL = "postgresql://postgres:pw@db.nowcuhwgeerzqlpweyxj.supabase.co:5432/postgres";
const APPROVED_POOLER_URL =
  "postgresql://postgres.nowcuhwgeerzqlpweyxj:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres";
const PRODUCTION_URL = "postgresql://postgres:pw@db.jvssnpvrcwjxldfeddnw.supabase.co:5432/postgres";
const PRODUCTION_POOLER_URL =
  "postgresql://postgres.jvssnpvrcwjxldfeddnw:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

/**
 * Round-4 finding R4-04: SUPABASE_DB_URL's environment-validation behavior
 * (mandatory in CI, project-ref-checked always, unreachable-in-CI fails
 * loud) needed automated coverage, not just the manual reasoning in the
 * migration/finding comments.
 */
describe("connectToTestDb", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockConnect.mockReset();
    delete process.env.SUPABASE_DB_URL;
    delete process.env.CI;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("returns null locally when SUPABASE_DB_URL is unset (optional convenience)", async () => {
    const { connectToTestDb } = await import("./db-connection");
    const result = await connectToTestDb();
    expect(result).toBeNull();
  });

  it("throws in CI when SUPABASE_DB_URL is unset -- never silently skips", async () => {
    process.env.CI = "true";
    const { connectToTestDb } = await import("./db-connection");
    await expect(connectToTestDb()).rejects.toThrow(/required in CI/);
  });

  it("rejects the real production project's URL, even locally", async () => {
    process.env.SUPABASE_DB_URL = PRODUCTION_URL;
    const { connectToTestDb } = await import("./db-connection");
    await expect(connectToTestDb()).rejects.toThrow(/does not resolve to the approved/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects an unparseable/unrecognized URL", async () => {
    process.env.SUPABASE_DB_URL = "postgresql://postgres:pw@some-other-host:5432/postgres";
    const { connectToTestDb } = await import("./db-connection");
    await expect(connectToTestDb()).rejects.toThrow(/does not resolve to the approved/);
  });

  it("connects successfully to the approved project when reachable", async () => {
    process.env.SUPABASE_DB_URL = APPROVED_URL;
    mockConnect.mockResolvedValue(undefined);
    const { connectToTestDb } = await import("./db-connection");
    const result = await connectToTestDb();
    expect(result).not.toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("connects successfully via the pooler URL form (project ref in the username, not the hostname)", async () => {
    process.env.SUPABASE_DB_URL = APPROVED_POOLER_URL;
    mockConnect.mockResolvedValue(undefined);
    const { connectToTestDb } = await import("./db-connection");
    const result = await connectToTestDb();
    expect(result).not.toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("rejects the production project's pooler URL, even locally", async () => {
    process.env.SUPABASE_DB_URL = PRODUCTION_POOLER_URL;
    const { connectToTestDb } = await import("./db-connection");
    await expect(connectToTestDb()).rejects.toThrow(/does not resolve to the approved/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("returns null locally when the approved project is unreachable", async () => {
    process.env.SUPABASE_DB_URL = APPROVED_URL;
    mockConnect.mockRejectedValue(new Error("connection refused"));
    const { connectToTestDb } = await import("./db-connection");
    const result = await connectToTestDb();
    expect(result).toBeNull();
  });

  it("throws in CI when the approved project is unreachable -- never silently skips", async () => {
    process.env.CI = "true";
    process.env.SUPABASE_DB_URL = APPROVED_URL;
    mockConnect.mockRejectedValue(new Error("connection refused"));
    const { connectToTestDb } = await import("./db-connection");
    await expect(connectToTestDb()).rejects.toThrow(/connection failed/);
  });
});

const APPROVED_REF = "nowcuhwgeerzqlpweyxj";
const PRODUCTION_REF = "jvssnpvrcwjxldfeddnw";

/**
 * Round-5 finding R5-02: projectRefFromDbUrl() used to run two regexes
 * against the raw connection string with `.exec()` -- an unanchored
 * search that finds its pattern ANYWHERE in the string, including the
 * query string, path, or password, none of which the server actually
 * authenticates against. These are adversarial cases specifically
 * targeting that class of bug -- each one plants the approved ref
 * somewhere the parser must NOT read it from, while the URL's actual
 * connection target is a different (here: production) host.
 */
describe("projectRefFromDbUrl (adversarial -- the allowlist this backs must not be foolable)", () => {
  it("extracts the ref from a genuine direct connection", () => {
    expect(projectRefFromDbUrl(`postgresql://postgres:pw@db.${APPROVED_REF}.supabase.co:5432/postgres`)).toBe(
      APPROVED_REF,
    );
  });

  it("extracts the ref from a genuine pooler connection", () => {
    expect(
      projectRefFromDbUrl(`postgresql://postgres.${APPROVED_REF}:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`),
    ).toBe(APPROVED_REF);
  });

  it("does not read the ref out of the query string on a production pooler connection", () => {
    const url =
      `postgresql://postgres.${PRODUCTION_REF}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` +
      `?application_name=db.${APPROVED_REF}.supabase.co`;
    expect(projectRefFromDbUrl(url)).toBe(PRODUCTION_REF);
  });

  it("does not read the ref out of the path on a connection to an unrelated host", () => {
    const url = `postgresql://postgres:pw@evil.example.com:5432/db.${APPROVED_REF}.supabase.co`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("does not read the ref out of the password", () => {
    const url = `postgresql://postgres:db.${APPROVED_REF}.supabase.co@evil.example.com:5432/postgres`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("does not read the ref out of the fragment", () => {
    const url = `postgresql://postgres:pw@evil.example.com:5432/postgres#db.${APPROVED_REF}.supabase.co`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("rejects a suffixed lookalike hostname (the real host is not exactly db.<ref>.supabase.co)", () => {
    const url = `postgresql://postgres:pw@db.${APPROVED_REF}.supabase.co.evil.com:5432/postgres`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("rejects a lookalike pooler hostname suffix", () => {
    const url = `postgresql://postgres.${APPROVED_REF}:pw@aws-1-eu-west-1.pooler.supabase.com.evil.com:6543/postgres`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("decodes a percent-encoded pooler username instead of failing to match it", () => {
    // "postgres.<ref>" with the dot percent-encoded -- still the same
    // logical username, must resolve the same ref, not silently reject it
    // (a false negative here would be safe but wrong, and could mask a
    // real bug in whatever encodes these strings elsewhere).
    const url = `postgresql://postgres%2E${APPROVED_REF}:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;
    expect(projectRefFromDbUrl(url)).toBe(APPROVED_REF);
  });

  it("rejects a malformed URL outright", () => {
    expect(projectRefFromDbUrl("not a url at all")).toBeNull();
    expect(projectRefFromDbUrl("")).toBeNull();
  });

  it("rejects a non-Postgres protocol even with an otherwise-matching host", () => {
    const url = `https://postgres:pw@db.${APPROVED_REF}.supabase.co:5432/postgres`;
    expect(projectRefFromDbUrl(url)).toBeNull();
  });

  it("faithfully extracts the production project's ref from its direct and pooler URLs (the caller, connectToTestDb, is what rejects it)", () => {
    expect(projectRefFromDbUrl(`postgresql://postgres:pw@db.${PRODUCTION_REF}.supabase.co:5432/postgres`)).toBe(
      PRODUCTION_REF,
    );
    expect(
      projectRefFromDbUrl(
        `postgresql://postgres.${PRODUCTION_REF}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(PRODUCTION_REF);
  });
});
