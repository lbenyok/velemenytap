import { describe, it, expect } from "vitest";
import { parseArgs, validateMigrationPlan, loadEnvironments, projectRefFromDbUrl } from "./rollout.mjs";

const TEST_REF = "abcdefghijklmnopqrst";
const TEST_ENVIRONMENTS = loadEnvironments(
  JSON.stringify({
    production: {
      supabaseProjectRef: TEST_REF,
      allowedOrigin: "https://veleminytap.vercel.app",
      healthUrl: "https://veleminytap.vercel.app/api/health",
      environment: "production",
    },
    staging: {
      supabaseProjectRef: "stagingref00000000000",
      allowedOrigin: "https://staging.example.com",
      healthUrl: "https://staging.example.com/api/health",
      environment: "preview",
    },
  }),
);

const VALID_SHA = "a".repeat(40);

const VALID_ARGV = [
  "--db-url",
  `postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`,
  "--expand",
  "20260101000000_a.sql",
  "--enforce",
  "20260102000000_b.sql",
  "--expected-sha",
  VALID_SHA,
  "--target",
  "production",
];

describe("loadEnvironments", () => {
  it("parses a valid manifest", () => {
    expect(Object.keys(TEST_ENVIRONMENTS)).toEqual(["production", "staging"]);
  });

  it("rejects an entry missing a required field", () => {
    expect(() =>
      loadEnvironments(JSON.stringify({ production: { supabaseProjectRef: "x", allowedOrigin: "https://x" } })),
    ).toThrow(/missing a valid "healthUrl"/);
  });

  it("rejects an entry with an empty-string field", () => {
    expect(() =>
      loadEnvironments(
        JSON.stringify({
          production: { supabaseProjectRef: "x", allowedOrigin: "https://x", healthUrl: "", environment: "production" },
        }),
      ),
    ).toThrow(/missing a valid "healthUrl"/);
  });
});

describe("projectRefFromDbUrl (mirrors e2e/support/db-connection.ts's own coverage -- kept minimal here)", () => {
  it("extracts the ref from a direct connection", () => {
    expect(projectRefFromDbUrl(`postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`)).toBe(TEST_REF);
  });

  it("extracts the ref from a pooler connection's username, not its shared hostname", () => {
    expect(
      projectRefFromDbUrl(`postgresql://postgres.${TEST_REF}:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`),
    ).toBe(TEST_REF);
  });

  it("does not read the ref out of the query string", () => {
    const url = `postgresql://postgres:pw@db.other.supabase.co:5432/postgres?x=db.${TEST_REF}.supabase.co`;
    expect(projectRefFromDbUrl(url)).toBe("other");
  });

  it("returns null (not a thrown URIError) for a malformed percent-encoded pooler username", () => {
    const url = `postgresql://postgres%ZZ:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;
    expect(() => projectRefFromDbUrl(url)).not.toThrow();
    expect(projectRefFromDbUrl(url)).toBeNull();
  });
});

describe("parseArgs", () => {
  it("parses a fully valid argument set", () => {
    const args = parseArgs(VALID_ARGV, TEST_ENVIRONMENTS);
    expect(args.expand).toEqual(["20260101000000_a.sql"]);
    expect(args.enforce).toEqual(["20260102000000_b.sql"]);
    expect(args.expectedSha).toBe(VALID_SHA);
    expect(args.dryRun).toBe(false);
    expect(args.target).toBe("production");
    expect(args.allowedOrigin).toBe("https://veleminytap.vercel.app");
    expect(args.healthUrl).toBe("https://veleminytap.vercel.app/api/health");
    expect(args.environment).toBe("production");
  });

  it("requires --expand even when there's nothing to expand -- an empty string is explicit, omitting the flag is not", () => {
    expect(() =>
      parseArgs(
        VALID_ARGV.filter((_, i) => !(VALID_ARGV[i - 1] === "--expand" || VALID_ARGV[i] === "--expand")),
        TEST_ENVIRONMENTS,
      ),
    ).toThrow(/Missing required argument: --expand/);
  });

  it("accepts an explicitly empty --expand", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--expand") + 1] = "";
    const args = parseArgs(argv, TEST_ENVIRONMENTS);
    expect(args.expand).toEqual([]);
  });

  it("rejects a duplicate name within --enforce", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--enforce") + 1] = "20260102000000_b.sql,20260102000000_b.sql";
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/more than once/);
  });

  it("rejects a migration listed in both --expand and --enforce", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--enforce") + 1] = "20260101000000_a.sql";
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/both --expand and --enforce/);
  });

  it("rejects a malformed --expected-sha", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--expected-sha") + 1] = "not-a-sha!";
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/full 40-character git commit SHA/);
  });

  /**
   * Round-6 finding R6-11: a short SHA used to pass this check (7-40 hex
   * accepted) and only fail much later, after phase 1 had already applied
   * the expand migrations and the full deploy-timeout had elapsed --
   * because /api/health always reports the full 40-character SHA and the
   * comparison is exact string equality, a short one can never match.
   */
  it("rejects a short (7-character) SHA that could never match /api/health's full SHA", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--expected-sha") + 1] = "a1b2c3d";
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/full 40-character git commit SHA/);
  });

  it("accepts a full 40-character SHA", () => {
    expect(() => parseArgs(VALID_ARGV, TEST_ENVIRONMENTS)).not.toThrow();
  });

  it("requires --db-url", () => {
    const argv = VALID_ARGV.filter((_, i) => VALID_ARGV[i - 1] !== "--db-url" && VALID_ARGV[i] !== "--db-url");
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/--db-url/);
  });

  it("rejects a non-finite --drain-seconds", () => {
    const argv = [...VALID_ARGV, "--drain-seconds", "not-a-number"];
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
  });

  it("rejects a negative --deploy-timeout-seconds", () => {
    const argv = [...VALID_ARGV, "--deploy-timeout-seconds", "-5"];
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
  });

  it("rejects Infinity for a timeout argument", () => {
    const argv = [...VALID_ARGV, "--drain-seconds", "Infinity"];
    expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
  });

  /**
   * Round-6 finding R6-07: --allowed-origin/--health-url used to be
   * caller-supplied arguments, trusted as long as they agreed with each
   * other -- proving nothing about whether --db-url belonged to the same
   * application. --target now selects a fixed, committed manifest entry;
   * these tests cover the new trust boundary directly.
   */
  describe("R6-07: --target binds origin/health-url/environment/project-ref together via the manifest", () => {
    it("requires --target", () => {
      const argv = VALID_ARGV.filter((_, i) => VALID_ARGV[i - 1] !== "--target" && VALID_ARGV[i] !== "--target");
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Missing required argument: --target/);
    });

    it("rejects a --target not defined in the manifest", () => {
      const argv = [...VALID_ARGV];
      argv[argv.indexOf("--target") + 1] = "nonexistent";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/not defined in rollout-environments\.json/);
    });

    it("rejects a --db-url whose project ref doesn't match --target's manifest entry", () => {
      const argv = [...VALID_ARGV];
      // Points at the STAGING project's ref while --target says production.
      argv[argv.indexOf("--db-url") + 1] = `postgresql://postgres:pw@db.stagingref00000000000.supabase.co:5432/postgres`;
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/does not match --target|expects "abcdefghijklmnopqrst"/);
    });

    it("rejects a --db-url that doesn't resolve to any project ref at all", () => {
      const argv = [...VALID_ARGV];
      argv[argv.indexOf("--db-url") + 1] = "postgresql://postgres:pw@some-attacker-controlled-host.example.com:5432/postgres";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/unparseable/);
    });

    it("a matching --target/--db-url pair for a DIFFERENT (non-production) environment still works, deriving that environment's own values", () => {
      const argv = [...VALID_ARGV];
      argv[argv.indexOf("--db-url") + 1] = `postgresql://postgres:pw@db.stagingref00000000000.supabase.co:5432/postgres`;
      argv[argv.indexOf("--target") + 1] = "staging";
      const args = parseArgs(argv, TEST_ENVIRONMENTS);
      expect(args.allowedOrigin).toBe("https://staging.example.com");
      expect(args.environment).toBe("preview");
    });

    it("no longer accepts --allowed-origin/--health-url as arguments at all -- they're silently ignored, not honored", () => {
      const argv = [...VALID_ARGV, "--allowed-origin", "https://attacker.example.com", "--health-url", "https://attacker.example.com/api/health"];
      const args = parseArgs(argv, TEST_ENVIRONMENTS);
      // The manifest's values win regardless of what an attacker-controlled
      // caller tries to pass for these -- there is no code path left that
      // reads raw["allowed-origin"]/raw["health-url"] into the result at all.
      expect(args.allowedOrigin).toBe("https://veleminytap.vercel.app");
      expect(args.healthUrl).toBe("https://veleminytap.vercel.app/api/health");
    });
  });
});

/**
 * Round-5 R5-03/R5-04: this is the core fix for "a typo in --enforce
 * causes an enforce migration to run in phase 1" -- these adversarial
 * cases plant exactly the kinds of mismatch a typo, a stale manifest, or
 * an out-of-band migration addition would produce.
 */
describe("validateMigrationPlan", () => {
  const ALL_FILES = ["20260101000000_expand.sql", "20260102000000_enforce.sql", "20260103000000_other.sql"];

  it("passes when expand+enforce exactly account for every pending migration", () => {
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql", "20260102000000_enforce.sql"],
        ["20260101000000_expand.sql"],
        ["20260102000000_enforce.sql"],
        ALL_FILES,
      ),
    ).not.toThrow();
  });

  it("catches a typo'd --enforce filename that doesn't exist on disk at all", () => {
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql", "20260102000000_enforce.sql"],
        ["20260101000000_expand.sql"],
        ["20260102000000_enfroce.sql"], // typo
        ALL_FILES,
      ),
    ).toThrow(/does not exist/);
  });

  it("the real (correctly-named) enforce migration is then also caught as unaccounted-for, not silently treated as expand", () => {
    // This is the actual production-incident scenario from the finding:
    // a typo'd --enforce means the REAL enforce migration isn't named by
    // either list. The first thing to throw is the typo'd name not
    // existing (previous test) -- but if that check were somehow
    // bypassed, the real migration must still never be silently absorbed
    // into "everything else is expand."
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql", "20260102000000_enforce.sql"],
        ["20260101000000_expand.sql"],
        [], // pretend the typo'd name was simply dropped instead of caught
        ALL_FILES,
      ),
    ).toThrow(/not listed in --expand or --enforce/);
  });

  it("catches an --enforce migration that exists on disk but isn't currently pending (already applied)", () => {
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql"], // enforce migration NOT pending -- already applied
        ["20260101000000_expand.sql"],
        ["20260102000000_enforce.sql"],
        ALL_FILES,
      ),
    ).toThrow(/not currently pending/);
  });

  it("catches an unexpected pending migration that neither list names at all", () => {
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql", "20260102000000_enforce.sql", "20260103000000_other.sql"],
        ["20260101000000_expand.sql"],
        ["20260102000000_enforce.sql"],
        ALL_FILES,
      ),
    ).toThrow(/not listed in --expand or --enforce/);
  });

  it("catches a typo in --expand the same way as --enforce", () => {
    expect(() =>
      validateMigrationPlan(
        ["20260101000000_expand.sql"],
        ["20260101000000_expnad.sql"], // typo
        [],
        ALL_FILES,
      ),
    ).toThrow(/does not exist/);
  });

  it("passes with empty expand/enforce lists when nothing is pending", () => {
    expect(() => validateMigrationPlan([], [], [], ALL_FILES)).not.toThrow();
  });
});
