import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const PRODUCTION_URL = "postgresql://postgres:pw@db.jvssnpvrcwjxldfeddnw.supabase.co:5432/postgres";

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
