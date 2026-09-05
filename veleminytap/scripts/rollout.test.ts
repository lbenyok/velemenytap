import { describe, it, expect } from "vitest";
import { parseArgs, validateMigrationPlan } from "./rollout.mjs";

const VALID_ARGV = [
  "--db-url",
  "postgresql://postgres:pw@db.example.supabase.co:5432/postgres",
  "--expand",
  "20260101000000_a.sql",
  "--enforce",
  "20260102000000_b.sql",
  "--expected-sha",
  "abc1234",
  "--health-url",
  "https://veleminytap.vercel.app/api/health",
];

describe("parseArgs", () => {
  it("parses a fully valid argument set", () => {
    const args = parseArgs(VALID_ARGV);
    expect(args.expand).toEqual(["20260101000000_a.sql"]);
    expect(args.enforce).toEqual(["20260102000000_b.sql"]);
    expect(args.expectedSha).toBe("abc1234");
    expect(args.dryRun).toBe(false);
  });

  it("requires --expand even when there's nothing to expand -- an empty string is explicit, omitting the flag is not", () => {
    expect(() => parseArgs(VALID_ARGV.filter((_, i) => !(VALID_ARGV[i - 1] === "--expand" || VALID_ARGV[i] === "--expand")))).toThrow(
      /Missing required argument: --expand/,
    );
  });

  it("accepts an explicitly empty --expand", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--expand") + 1] = "";
    const args = parseArgs(argv);
    expect(args.expand).toEqual([]);
  });

  it("rejects a duplicate name within --enforce", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--enforce") + 1] = "20260102000000_b.sql,20260102000000_b.sql";
    expect(() => parseArgs(argv)).toThrow(/more than once/);
  });

  it("rejects a migration listed in both --expand and --enforce", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--enforce") + 1] = "20260101000000_a.sql";
    expect(() => parseArgs(argv)).toThrow(/both --expand and --enforce/);
  });

  it("rejects a malformed --expected-sha", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--expected-sha") + 1] = "not-a-sha!";
    expect(() => parseArgs(argv)).toThrow(/doesn't look like a git commit SHA/);
  });

  it("rejects --health-url on an origin that doesn't match --allowed-origin", () => {
    const argv = [...VALID_ARGV];
    argv[argv.indexOf("--health-url") + 1] = "https://attacker.example.com/api/health";
    expect(() => parseArgs(argv)).toThrow(/does not match --allowed-origin/);
  });

  it("accepts a matching custom --allowed-origin", () => {
    const argv = [
      ...VALID_ARGV.map((v, i) => (VALID_ARGV[i - 1] === "--health-url" ? "https://staging.example.com/api/health" : v)),
      "--allowed-origin",
      "https://staging.example.com",
    ];
    expect(() => parseArgs(argv)).not.toThrow();
  });

  it("rejects a non-https --allowed-origin", () => {
    const argv = [...VALID_ARGV, "--allowed-origin", "http://veleminytap.vercel.app"];
    expect(() => parseArgs(argv)).toThrow(/must be https/);
  });

  it("rejects a non-finite --drain-seconds", () => {
    const argv = [...VALID_ARGV, "--drain-seconds", "not-a-number"];
    expect(() => parseArgs(argv)).toThrow(/finite, non-negative number/);
  });

  it("rejects a negative --deploy-timeout-seconds", () => {
    const argv = [...VALID_ARGV, "--deploy-timeout-seconds", "-5"];
    expect(() => parseArgs(argv)).toThrow(/finite, non-negative number/);
  });

  it("rejects Infinity for a timeout argument", () => {
    const argv = [...VALID_ARGV, "--drain-seconds", "Infinity"];
    expect(() => parseArgs(argv)).toThrow(/finite, non-negative number/);
  });

  it("requires --db-url", () => {
    const argv = VALID_ARGV.filter((_, i) => VALID_ARGV[i - 1] !== "--db-url" && VALID_ARGV[i] !== "--db-url");
    expect(() => parseArgs(argv)).toThrow(/--db-url/);
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
