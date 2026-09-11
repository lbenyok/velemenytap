import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  parseArgs,
  validateMigrationPlan,
  validatePreparePlan,
  validateFinalizePlan,
  loadEnvironments,
  projectRefFromDbUrl,
  sh,
  redactConnectionStrings,
  credentialSecretsFromArgs,
  pollHealth,
  getPendingMigrations,
  runFinalize,
  runPrepare,
} from "./rollout.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

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
const DB_URL = `postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`;

const PREPARE_ARGV = [
  "prepare",
  "--db-url",
  DB_URL,
  "--expand",
  "20260101000000_a.sql",
  "--enforce",
  "20260102000000_b.sql",
  "--target",
  "production",
];

const FINALIZE_ARGV = [
  "finalize",
  "--db-url",
  DB_URL,
  "--enforce",
  "20260102000000_b.sql",
  "--expected-sha",
  VALID_SHA,
  "--target",
  "production",
];

function withoutFlag(argv: string[], flag: string) {
  return argv.filter((_, i) => argv[i - 1] !== flag && argv[i] !== flag);
}

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

  /**
   * Round-7 finding R7-04 (MEDIUM): allowedOrigin was stored in the
   * manifest but never actually checked against healthUrl -- a mismatched,
   * malformed, credentialed, or query/fragment-carrying entry would have
   * been silently accepted and trusted. These are now load-time validation
   * failures, not runtime surprises.
   */
  describe("R7-04: allowedOrigin/healthUrl are enforced, not just stored", () => {
    const base = { supabaseProjectRef: "x", environment: "production" };

    it("rejects a healthUrl whose origin doesn't match allowedOrigin", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({
            production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "https://attacker.example.com/api/health" },
          }),
        ),
      ).toThrow(/does not match its own allowedOrigin/);
    });

    it("rejects a non-https allowedOrigin", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({ production: { ...base, allowedOrigin: "http://real.example.com", healthUrl: "http://real.example.com/api/health" } }),
        ),
      ).toThrow(/allowedOrigin must be https/);
    });

    it("rejects a non-https healthUrl even when allowedOrigin is https", () => {
      // Different origins anyway (scheme is part of origin), but assert
      // the specific https-only message fires, not just the origin-match one.
      expect(() =>
        loadEnvironments(
          JSON.stringify({ production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "http://real.example.com/api/health" } }),
        ),
      ).toThrow(/healthUrl must be https|does not match/);
    });

    it("rejects a healthUrl carrying credentials", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({
            production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "https://user:pw@real.example.com/api/health" },
          }),
        ),
      ).toThrow(/must not carry credentials/);
    });

    it("rejects a healthUrl carrying a fragment", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({
            production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "https://real.example.com/api/health#x" },
          }),
        ),
      ).toThrow(/must not carry a fragment/);
    });

    it("rejects a healthUrl carrying a query string", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({
            production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "https://real.example.com/api/health?x=1" },
          }),
        ),
      ).toThrow(/must not carry a query string/);
    });

    it("rejects a malformed allowedOrigin", () => {
      expect(() =>
        loadEnvironments(JSON.stringify({ production: { ...base, allowedOrigin: "not a url", healthUrl: "https://real.example.com/api/health" } })),
      ).toThrow(/is not a valid URL/);
    });

    it("rejects a malformed healthUrl", () => {
      expect(() =>
        loadEnvironments(JSON.stringify({ production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "not a url" } })),
      ).toThrow(/is not a valid URL/);
    });

    it("accepts a genuinely matching, well-formed pair", () => {
      expect(() =>
        loadEnvironments(
          JSON.stringify({ production: { ...base, allowedOrigin: "https://real.example.com", healthUrl: "https://real.example.com/api/health" } }),
        ),
      ).not.toThrow();
    });
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

/**
 * Found during an independent review, after the original single-command
 * design nearly caused a real production incident (see rollout.mjs's own
 * header comment for the full story): --expected-sha had to already be
 * known before the migration this script exists to protect against had
 * even happened, and a squash/merge produces a SHA the pre-merge branch
 * HEAD can't predict anyway. Replaced with two subcommands, `prepare` and
 * `finalize`, each accepting and requiring only the arguments that make
 * sense for what it actually does -- these tests cover both the new
 * subcommand dispatch and the "phase separation" requirement directly:
 * a flag that belongs to one phase must be rejected, not silently
 * accepted, by the other.
 */
describe("parseArgs", () => {
  it("rejects a missing command", () => {
    expect(() => parseArgs([], TEST_ENVIRONMENTS)).toThrow(/must be "prepare" or "finalize"/);
  });

  it("rejects an unrecognized command", () => {
    expect(() => parseArgs(["deploy", "--db-url", DB_URL], TEST_ENVIRONMENTS)).toThrow(/must be "prepare" or "finalize"/);
  });

  describe("prepare", () => {
    it("parses a fully valid argument set", () => {
      const args = parseArgs(PREPARE_ARGV, TEST_ENVIRONMENTS);
      expect(args.command).toBe("prepare");
      expect(args.expand).toEqual(["20260101000000_a.sql"]);
      expect(args.enforce).toEqual(["20260102000000_b.sql"]);
      expect(args.expectedSha).toBe("");
      expect(args.dryRun).toBe(false);
      expect(args.target).toBe("production");
      expect(args.allowedOrigin).toBe("https://veleminytap.vercel.app");
      expect(args.healthUrl).toBe("https://veleminytap.vercel.app/api/health");
      expect(args.environment).toBe("production");
    });

    it("requires --expand even when there's nothing to expand -- an empty string is explicit, omitting the flag is not", () => {
      expect(() => parseArgs(withoutFlag(PREPARE_ARGV, "--expand"), TEST_ENVIRONMENTS)).toThrow(
        /Missing required argument: --expand/,
      );
    });

    it("accepts an explicitly empty --expand", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--expand") + 1] = "";
      const args = parseArgs(argv, TEST_ENVIRONMENTS);
      expect(args.expand).toEqual([]);
    });

    it("requires --enforce even when there's nothing to enforce", () => {
      expect(() => parseArgs(withoutFlag(PREPARE_ARGV, "--enforce"), TEST_ENVIRONMENTS)).toThrow(
        /Missing required argument: --enforce/,
      );
    });

    it("rejects a duplicate name within --enforce", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--enforce") + 1] = "20260102000000_b.sql,20260102000000_b.sql";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/more than once/);
    });

    it("rejects a migration listed in both --expand and --enforce", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--enforce") + 1] = "20260101000000_a.sql";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/both --expand and --enforce/);
    });

    it("requires --db-url", () => {
      expect(() => parseArgs(withoutFlag(PREPARE_ARGV, "--db-url"), TEST_ENVIRONMENTS)).toThrow(/--db-url/);
    });

    /**
     * Phase separation: --expected-sha only ever makes sense once the
     * commit it names has actually been merged and deployed, which is
     * exactly what hasn't happened yet when prepare runs -- prepare must
     * refuse it outright rather than silently accept and ignore it.
     */
    it("rejects --expected-sha (belongs to finalize, not prepare)", () => {
      const argv = [...PREPARE_ARGV, "--expected-sha", VALID_SHA];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/--expected-sha belongs to "finalize"/);
    });

    it("rejects --drain-seconds (belongs to finalize, not prepare)", () => {
      const argv = [...PREPARE_ARGV, "--drain-seconds", "10"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/--drain-seconds belongs to "finalize"/);
    });

    it("rejects --deploy-timeout-seconds (belongs to finalize, not prepare)", () => {
      const argv = [...PREPARE_ARGV, "--deploy-timeout-seconds", "10"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/--deploy-timeout-seconds belongs to "finalize"/);
    });
  });

  describe("finalize", () => {
    it("parses a fully valid argument set", () => {
      const args = parseArgs(FINALIZE_ARGV, TEST_ENVIRONMENTS);
      expect(args.command).toBe("finalize");
      expect(args.expand).toEqual([]);
      expect(args.enforce).toEqual(["20260102000000_b.sql"]);
      expect(args.expectedSha).toBe(VALID_SHA);
      expect(args.dryRun).toBe(false);
      expect(args.drainSeconds).toBe(60);
      expect(args.deployTimeoutSeconds).toBe(300);
      expect(args.target).toBe("production");
      expect(args.allowedOrigin).toBe("https://veleminytap.vercel.app");
      expect(args.environment).toBe("production");
    });

    it("requires --enforce", () => {
      expect(() => parseArgs(withoutFlag(FINALIZE_ARGV, "--enforce"), TEST_ENVIRONMENTS)).toThrow(
        /Missing required argument: --enforce/,
      );
    });

    it("requires --expected-sha", () => {
      expect(() => parseArgs(withoutFlag(FINALIZE_ARGV, "--expected-sha"), TEST_ENVIRONMENTS)).toThrow(
        /Missing required argument: --expected-sha/,
      );
    });

    it("requires --db-url", () => {
      expect(() => parseArgs(withoutFlag(FINALIZE_ARGV, "--db-url"), TEST_ENVIRONMENTS)).toThrow(/--db-url/);
    });

    it("rejects a duplicate name within --enforce", () => {
      const argv = [...FINALIZE_ARGV];
      argv[argv.indexOf("--enforce") + 1] = "20260102000000_b.sql,20260102000000_b.sql";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/more than once/);
    });

    it("rejects a malformed --expected-sha", () => {
      const argv = [...FINALIZE_ARGV];
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
      const argv = [...FINALIZE_ARGV];
      argv[argv.indexOf("--expected-sha") + 1] = "a1b2c3d";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/full 40-character git commit SHA/);
    });

    it("accepts a full 40-character SHA", () => {
      expect(() => parseArgs(FINALIZE_ARGV, TEST_ENVIRONMENTS)).not.toThrow();
    });

    it("rejects a non-finite --drain-seconds", () => {
      const argv = [...FINALIZE_ARGV, "--drain-seconds", "not-a-number"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
    });

    it("rejects a negative --deploy-timeout-seconds", () => {
      const argv = [...FINALIZE_ARGV, "--deploy-timeout-seconds", "-5"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
    });

    it("rejects Infinity for a timeout argument", () => {
      const argv = [...FINALIZE_ARGV, "--drain-seconds", "Infinity"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/finite, non-negative number/);
    });

    /**
     * Phase separation, the mirror case: --expand only ever makes sense
     * before the merge/deploy that finalize itself waits for -- by the
     * time finalize runs, expand migrations should already be applied
     * (finalize's own validateFinalizePlan enforces this), so accepting an
     * --expand list here would be meaningless at best and misleading at
     * worst.
     */
    it("rejects --expand (belongs to prepare, not finalize)", () => {
      const argv = [...FINALIZE_ARGV, "--expand", "20260101000000_a.sql"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/--expand belongs to "prepare"/);
    });
  });

  /**
   * Round-6 finding R6-07: --allowed-origin/--health-url used to be
   * caller-supplied arguments, trusted as long as they agreed with each
   * other -- proving nothing about whether --db-url belonged to the same
   * application. --target now selects a fixed, committed manifest entry;
   * these tests cover the new trust boundary directly, common to both
   * subcommands.
   */
  describe("R6-07: --target binds origin/health-url/environment/project-ref together via the manifest", () => {
    it("requires --target", () => {
      expect(() => parseArgs(withoutFlag(PREPARE_ARGV, "--target"), TEST_ENVIRONMENTS)).toThrow(
        /Missing required argument: --target/,
      );
    });

    it("rejects a --target not defined in the manifest", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--target") + 1] = "nonexistent";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/not defined in rollout-environments\.json/);
    });

    it("rejects a --db-url whose project ref doesn't match --target's manifest entry", () => {
      const argv = [...PREPARE_ARGV];
      // Points at the STAGING project's ref while --target says production.
      argv[argv.indexOf("--db-url") + 1] = `postgresql://postgres:pw@db.stagingref00000000000.supabase.co:5432/postgres`;
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/does not match --target|expects "abcdefghijklmnopqrst"/);
    });

    it("rejects a --db-url that doesn't resolve to any project ref at all", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--db-url") + 1] = "postgresql://postgres:pw@some-attacker-controlled-host.example.com:5432/postgres";
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/unparseable/);
    });

    it("a matching --target/--db-url pair for a DIFFERENT (non-production) environment still works, deriving that environment's own values", () => {
      const argv = [...PREPARE_ARGV];
      argv[argv.indexOf("--db-url") + 1] = `postgresql://postgres:pw@db.stagingref00000000000.supabase.co:5432/postgres`;
      argv[argv.indexOf("--target") + 1] = "staging";
      const args = parseArgs(argv, TEST_ENVIRONMENTS);
      expect(args.allowedOrigin).toBe("https://staging.example.com");
      expect(args.environment).toBe("preview");
    });

    /**
     * Round-7 finding R7-04: this used to silently ACCEPT and ignore
     * --allowed-origin/--health-url (they were parsed into `raw` but
     * nothing ever read them out again) -- a caller who believed they were
     * still setting a safety-related flag got no error and no effect.
     * Unknown flags, these two specifically included, are now rejected
     * outright.
     */
    it("rejects the removed --allowed-origin flag outright, not silently", () => {
      const argv = [...PREPARE_ARGV, "--allowed-origin", "https://attacker.example.com"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --allowed-origin[\s\S]*removed/);
    });

    it("rejects the removed --health-url flag outright, not silently", () => {
      const argv = [...PREPARE_ARGV, "--health-url", "https://attacker.example.com/api/health"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --health-url[\s\S]*removed/);
    });

    it("rejects any other unrecognized flag too", () => {
      const argv = [...PREPARE_ARGV, "--totally-made-up-flag", "value"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --totally-made-up-flag/);
    });

    it("rejects a bare positional argument that isn't a --flag", () => {
      const argv = [...PREPARE_ARGV, "some-stray-value"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/every argument after the command must be a --flag/);
    });
  });
});

/**
 * Round-5 R5-03/R5-04: this is the core fix for "a typo in --enforce
 * causes an enforce migration to run in phase 1" -- these adversarial
 * cases plant exactly the kinds of mismatch a typo, a stale manifest, or
 * an out-of-band migration addition would produce. Left completely
 * unchanged by the prepare/finalize split: this function still covers a
 * fresh, from-scratch rollout with no prior partial progress, and its
 * strict "every named migration must currently be pending" semantics are
 * still exactly right for that case. See validatePreparePlan/
 * validateFinalizePlan below for the phase-specific, resumability-aware
 * variants `prepare`/`finalize` actually use.
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

/**
 * Found during an independent review of the original single-command
 * design's own production-deployment race (see rollout.mjs's header
 * comment): `prepare` must be safely re-runnable after a prior run of
 * ITSELF fully or partially succeeded -- a real interruption scenario,
 * e.g. a network drop mid-`db push` after 2 of 4 expand migrations
 * applied. validateMigrationPlan's strict "every named migration must
 * currently be pending" check is exactly wrong for that retry (the
 * already-applied expand migrations are the SUCCESS case, not an error),
 * so this is a separate function with deliberately asymmetric tolerance:
 * lenient on --expand (may or may not still be pending), strict on
 * --enforce (must still be pending -- prepare's own `db push` stages
 * enforce files out of the directory first, so one becoming non-pending
 * here can only mean something applied it out of band, most likely that
 * `finalize` already ran).
 */
describe("validatePreparePlan", () => {
  const ALL_FILES = ["20260101000000_expand.sql", "20260102000000_expand2.sql", "20260103000000_enforce.sql"];

  it("passes on a fresh run: everything named by expand+enforce is pending", () => {
    expect(() =>
      validatePreparePlan(
        ["20260101000000_expand.sql", "20260102000000_expand2.sql", "20260103000000_enforce.sql"],
        ["20260101000000_expand.sql", "20260102000000_expand2.sql"],
        ["20260103000000_enforce.sql"],
        ALL_FILES,
      ),
    ).not.toThrow();
  });

  it("retry after a completed prepare phase: tolerates ALL expand migrations already applied, enforce still pending", () => {
    expect(() =>
      validatePreparePlan(
        ["20260103000000_enforce.sql"], // only enforce remains pending -- expand fully done
        ["20260101000000_expand.sql", "20260102000000_expand2.sql"],
        ["20260103000000_enforce.sql"],
        ALL_FILES,
      ),
    ).not.toThrow();
  });

  it("retry after a PARTIALLY completed prepare phase: tolerates some (not all) expand migrations already applied", () => {
    expect(() =>
      validatePreparePlan(
        ["20260102000000_expand2.sql", "20260103000000_enforce.sql"], // first expand migration already applied
        ["20260101000000_expand.sql", "20260102000000_expand2.sql"],
        ["20260103000000_enforce.sql"],
        ALL_FILES,
      ),
    ).not.toThrow();
  });

  it("still throws if an --enforce migration exists on disk but is no longer pending -- anomalous during prepare", () => {
    expect(() =>
      validatePreparePlan(
        [], // enforce migration already gone too -- most likely finalize already ran
        ["20260101000000_expand.sql", "20260102000000_expand2.sql"],
        ["20260103000000_enforce.sql"],
        ALL_FILES,
      ),
    ).toThrow(/should never become applied during the prepare phase/);
  });

  it("still catches a typo'd --expand filename that doesn't exist on disk", () => {
    expect(() =>
      validatePreparePlan(
        ["20260103000000_enforce.sql"],
        ["20260101000000_expnad.sql"], // typo
        ["20260103000000_enforce.sql"],
        ALL_FILES,
      ),
    ).toThrow(/does not exist/);
  });

  it("still catches a typo'd --enforce filename that doesn't exist on disk", () => {
    expect(() =>
      validatePreparePlan(
        ["20260101000000_expand.sql", "20260103000000_enfroce.sql"],
        ["20260101000000_expand.sql"],
        ["20260103000000_enfroce.sql"], // typo
        ALL_FILES,
      ),
    ).toThrow(/does not exist/);
  });

  it("still throws when a pending migration is unaccounted for by either list", () => {
    expect(() =>
      validatePreparePlan(
        ["20260101000000_expand.sql", "20260102000000_expand2.sql", "20260103000000_enforce.sql"],
        ["20260101000000_expand.sql"],
        [], // 20260102000000_expand2.sql and 20260103000000_enforce.sql both unaccounted for
        ALL_FILES,
      ),
    ).toThrow(/not listed in --expand or --enforce/);
  });

  it("passes with empty expand/enforce lists when nothing is pending", () => {
    expect(() => validatePreparePlan([], [], [], ALL_FILES)).not.toThrow();
  });
});

/**
 * The mirror case of validatePreparePlan, and the direct fix for this
 * round's Finding 1 requirement that finalize "must refuse to continue if
 * any expand migration is still pending": tolerant of --enforce migrations
 * already (fully or partially) applied -- required for finalize to be
 * safely re-runnable after a prior run of ITSELF succeeded or was
 * interrupted -- but strict about anything ELSE being pending, which can
 * only mean an expand migration never finished (prepare didn't run, ran
 * against a different database, or was itself interrupted).
 */
describe("validateFinalizePlan", () => {
  const ALL_FILES = ["20260101000000_expand.sql", "20260102000000_enforce.sql", "20260103000000_enforce2.sql"];

  it("fresh run: returns the full --enforce list as remaining when everything is still pending", () => {
    const result = validateFinalizePlan(
      ["20260102000000_enforce.sql", "20260103000000_enforce2.sql"],
      ["20260102000000_enforce.sql", "20260103000000_enforce2.sql"],
      ALL_FILES,
    );
    expect(result.remaining).toEqual(["20260102000000_enforce.sql", "20260103000000_enforce2.sql"]);
  });

  it("retry after a PARTIALLY completed finalize: tolerates some --enforce migrations already applied, returning only what's left", () => {
    const result = validateFinalizePlan(
      ["20260103000000_enforce2.sql"], // first enforce migration already applied
      ["20260102000000_enforce.sql", "20260103000000_enforce2.sql"],
      ALL_FILES,
    );
    expect(result.remaining).toEqual(["20260103000000_enforce2.sql"]);
  });

  it("retry after a FULLY completed finalize: returns an empty remaining list without throwing", () => {
    const result = validateFinalizePlan([], ["20260102000000_enforce.sql", "20260103000000_enforce2.sql"], ALL_FILES);
    expect(result.remaining).toEqual([]);
  });

  /**
   * This is the direct test for the race this round's Finding 1 exists to
   * close: finalize must never apply the enforce migrations while an
   * expand migration is still outstanding, since that's exactly the
   * "new code needs a column that doesn't exist yet" window.
   */
  it("refuses to continue if anything pending is not in --enforce -- an expand migration that never finished", () => {
    expect(() =>
      validateFinalizePlan(
        ["20260101000000_expand.sql", "20260102000000_enforce.sql"], // expand migration still pending!
        ["20260102000000_enforce.sql"],
        ALL_FILES,
      ),
    ).toThrow(/Run `prepare` again first/);
  });

  it("refuses to continue if an entirely unplanned migration neither phase named is pending", () => {
    expect(() =>
      validateFinalizePlan(
        ["20260102000000_enforce.sql", "some-unplanned-migration.sql"],
        ["20260102000000_enforce.sql"],
        [...ALL_FILES, "some-unplanned-migration.sql"],
      ),
    ).toThrow(/are pending that are not in --enforce/);
  });

  it("still catches a typo'd --enforce filename that doesn't exist on disk", () => {
    expect(() =>
      validateFinalizePlan(["20260102000000_enfroce.sql"], ["20260102000000_enfroce.sql"], ALL_FILES),
    ).toThrow(/does not exist/);
  });

  it("passes with an empty --enforce list when nothing is pending", () => {
    const result = validateFinalizePlan([], [], ALL_FILES);
    expect(result.remaining).toEqual([]);
  });
});

/**
 * Round-7 finding R7-02 (HIGH): execFileSync's own thrown Error embeds the
 * complete command line (including --db-url's real password) in its
 * `.message`, plus separate `.stdout`/`.stderr` -- none of which sh()'s own
 * redacted console.log line ever protected, since that only covers the
 * happy-path log line, never a thrown failure. The top-level catch in
 * main() prints exactly this message unchanged, which would disclose a
 * production database password to whatever captures this script's stderr.
 */
describe("R7-02: subprocess failures never disclose connection-string credentials", () => {
  const USERNAME_CANARY = "postgres.CANARY_USER_R7";
  const PASSWORD_CANARY = "CANARY_PW_R7_super_secret";
  const CANARY_DB_URL = `postgresql://${USERNAME_CANARY}:${PASSWORD_CANARY}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  function mockFailure({ message, stdout, stderr }: { message: string; stdout?: string; stderr?: string }) {
    const err = new Error(message) as Error & { status: number; stdout: string; stderr: string };
    err.status = 1;
    err.stdout = stdout ?? "";
    err.stderr = stderr ?? "";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
  }

  describe("redactConnectionStrings", () => {
    it("redacts the userinfo of any postgres(ql):// URL found in text, generically", () => {
      const text = `Connection failed: ${CANARY_DB_URL}`;
      const result = redactConnectionStrings(text);
      expect(result).not.toContain(PASSWORD_CANARY);
      expect(result).not.toContain(USERNAME_CANARY);
      expect(result).toContain("aws-1-eu-west-1.pooler.supabase.com");
      expect(result).toContain("[redacted]");
    });

    it("redacts a bare extracted secret even outside a full URL context", () => {
      const result = redactConnectionStrings(`auth failed for user "${USERNAME_CANARY}" password "${PASSWORD_CANARY}"`, [
        USERNAME_CANARY,
        PASSWORD_CANARY,
      ]);
      expect(result).not.toContain(PASSWORD_CANARY);
      expect(result).not.toContain(USERNAME_CANARY);
    });

    it("redacts a percent-decoded secret when only the encoded form is in the extracted list, and vice versa", () => {
      const encoded = "pw%2Bwith%2Bplus";
      const decoded = decodeURIComponent(encoded);
      expect(redactConnectionStrings(`leaked: ${decoded}`, [encoded, decoded])).not.toContain(decoded);
    });

    it("leaves non-connection-string text untouched", () => {
      expect(redactConnectionStrings("plain error, nothing sensitive here")).toBe(
        "plain error, nothing sensitive here",
      );
    });

    it("handles non-string input without throwing", () => {
      expect(redactConnectionStrings(undefined)).toBeUndefined();
      expect(redactConnectionStrings(null)).toBeNull();
    });
  });

  describe("credentialSecretsFromArgs", () => {
    it("extracts both username and password, encoded and decoded, from a db-url argument", () => {
      const secrets = credentialSecretsFromArgs(["supabase", "db", "push", "--db-url", CANARY_DB_URL]);
      expect(secrets).toContain(USERNAME_CANARY);
      expect(secrets).toContain(PASSWORD_CANARY);
    });

    it("ignores non-URL arguments without throwing", () => {
      expect(() => credentialSecretsFromArgs(["supabase", "migration", "list", "--output-format", "json"])).not.toThrow();
    });
  });

  describe("sh() sanitizes every failure path", () => {
    it("never discloses the canary through a failed 'supabase migration list' call", () => {
      mockFailure({
        message: `Command failed: npx supabase migration list --db-url ${CANARY_DB_URL} --output-format json`,
        stderr: `connection to server failed: ${CANARY_DB_URL}`,
      });
      let caught: (Error & { stdout?: string; stderr?: string }) | undefined;
      try {
        sh("npx", ["supabase", "migration", "list", "--db-url", CANARY_DB_URL, "--output-format", "json"]);
      } catch (err) {
        caught = err as Error & { stdout?: string; stderr?: string };
      }
      expect(caught).toBeDefined();
      const serialized = JSON.stringify({ message: caught?.message, stdout: caught?.stdout, stderr: caught?.stderr });
      expect(serialized).not.toContain(PASSWORD_CANARY);
      expect(serialized).not.toContain(USERNAME_CANARY);
    });

    it("never discloses the canary through a failed 'supabase db push' call", () => {
      mockFailure({
        message: `Command failed: npx supabase db push --db-url ${CANARY_DB_URL} --include-all --yes`,
        stdout: `applying migration...\nfailed: ${CANARY_DB_URL}`,
        stderr: `password authentication failed for user "${USERNAME_CANARY}"`,
      });
      let caught: (Error & { stdout?: string; stderr?: string }) | undefined;
      try {
        sh("npx", ["supabase", "db", "push", "--db-url", CANARY_DB_URL, "--include-all", "--yes"]);
      } catch (err) {
        caught = err as Error & { stdout?: string; stderr?: string };
      }
      expect(caught).toBeDefined();
      const serialized = JSON.stringify({ message: caught?.message, stdout: caught?.stdout, stderr: caught?.stderr });
      expect(serialized).not.toContain(PASSWORD_CANARY);
      expect(serialized).not.toContain(USERNAME_CANARY);
    });

    it("does not carry forward any un-sanitized property (e.g. .output) from the original error", () => {
      const err = new Error(`Command failed: ... ${CANARY_DB_URL}`) as Error & { status: number; output: unknown[] };
      err.status = 1;
      err.output = [null, `stdout with ${CANARY_DB_URL}`, `stderr with ${CANARY_DB_URL}`];
      vi.mocked(execFileSync).mockImplementation(() => {
        throw err;
      });
      let caught: (Error & { output?: unknown }) | undefined;
      try {
        sh("npx", ["supabase", "db", "push", "--db-url", CANARY_DB_URL]);
      } catch (e) {
        caught = e as Error & { output?: unknown };
      }
      expect(caught?.output).toBeUndefined();
    });

    it("still returns the real output on success (sanitization only applies to the failure path)", () => {
      vi.mocked(execFileSync).mockReturnValue('{"migrations":[]}');
      expect(sh("npx", ["supabase", "migration", "list"])).toBe('{"migrations":[]}');
    });
  });

  /**
   * Found during this round's own independent adversarial self-review, not
   * one of R7-01/02/04's named findings: getPendingMigrations() throws its
   * own error (not an execFileSync failure, so sanitizeSubprocessError
   * never runs) when the CLI's stdout doesn't contain a "{" -- and that
   * error used to embed the raw, un-redacted stdout directly. A future CLI
   * version mixing a warning/banner line containing --db-url into stdout
   * on an otherwise-successful exit would leak the credential through this
   * specific path, bypassing every other protection in this file.
   */
  describe("getPendingMigrations sanitizes even a non-execFileSync-failure error path", () => {
    it("redacts the db-url canary from the 'Expected JSON' error when stdout isn't JSON at all", () => {
      vi.mocked(execFileSync).mockReturnValue(`some banner mentioning ${CANARY_DB_URL} then no json`);
      expect(() => getPendingMigrations(CANARY_DB_URL)).toThrow(/Expected JSON/);
      try {
        getPendingMigrations(CANARY_DB_URL);
        expect.unreachable();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(PASSWORD_CANARY);
        expect(message).not.toContain(USERNAME_CANARY);
      }
    });
  });
});

/**
 * Round-7 finding R7-04 (MEDIUM): pollHealth used plain fetch(), which
 * follows redirects by default -- a health URL redirected (by a
 * compromised or misconfigured intermediary) to a different host could
 * return a spoofed ok+matching-commitSha+matching-environment response and
 * incorrectly authorize the enforce phase. Uses real local HTTP servers
 * (node:http), not mocked fetch, per the finding's explicit ask -- these
 * exercise fetch's actual redirect-following behavior, not an assumption
 * about it. Each retry-exhaustion case takes >=5s (pollHealth's own fixed
 * retry interval) since that isn't a round-7 finding to fix; timeouts are
 * extended accordingly rather than the test weakened to avoid the wait.
 */
describe("R7-04: pollHealth rejects redirects instead of following them", () => {
  const EXPECTED_SHA = "a".repeat(40);
  let servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function urlFor(server: http.Server) {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/api/health`;
  }

  function healthyBody() {
    return JSON.stringify({ ok: true, commitSha: EXPECTED_SHA, environment: "production" });
  }

  it("SUCCESS: a same-origin, non-redirecting response is accepted", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(healthyBody());
    });
    const body = await pollHealth(urlFor(server), EXPECTED_SHA, "production", 5);
    expect(body.ok).toBe(true);
  });

  it(
    "OFF-ORIGIN REDIRECT: a redirect to a different host is rejected, never followed",
    async () => {
      const attacker = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(healthyBody());
      });
      const legit = await startServer((_req, res) => {
        res.writeHead(302, { Location: urlFor(attacker) });
        res.end();
      });
      await expect(pollHealth(urlFor(legit), EXPECTED_SHA, "production", 1)).rejects.toThrow(/Timed out/);
    },
    10000,
  );

  it(
    "SAME-ORIGIN REDIRECT: a redirect to the identical origin is ALSO rejected -- healthUrl should never need to redirect at all",
    async () => {
      const server = await startServer((req, res) => {
        if (req.url === "/api/health") {
          res.writeHead(302, { Location: "/api/health-v2" });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(healthyBody());
        }
      });
      await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 1)).rejects.toThrow(/Timed out/);
    },
    10000,
  );

  it(
    "REDIRECT LOOP: never hangs or infinitely follows -- the first redirect alone fails it",
    async () => {
      const server = await startServer((req, res) => {
        res.writeHead(302, { Location: req.url === "/a" ? "/b" : "/a" });
        res.end();
      });
      await expect(pollHealth(`${urlFor(server).replace("/api/health", "")}/a`, EXPECTED_SHA, "production", 1)).rejects.toThrow(
        /Timed out/,
      );
    },
    10000,
  );

  it(
    "HTTP DOWNGRADE: a redirect from https-intended traffic to a plain-http location is rejected the same as any other redirect",
    async () => {
      // Simulated locally over http (no TLS available in a unit test), but
      // the mechanism under test -- redirect: "error" -- makes no
      // exception for scheme changes specifically; it rejects the redirect
      // response itself before its Location is ever inspected.
      const server = await startServer((_req, res) => {
        res.writeHead(302, { Location: "http://attacker.example.com/api/health" });
        res.end();
      });
      await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 1)).rejects.toThrow(/Timed out/);
    },
    10000,
  );

  it("a spoofed response on the CORRECT origin still can't help an attacker who can't reach that origin -- rejects mismatched commitSha/environment as before, unrelated to redirects", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, commitSha: "wrong-sha", environment: "production" }));
    });
    await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 1)).rejects.toThrow(/Timed out/);
  }, 10000);
});

/**
 * Found during an independent review of Finding 1: /api/health's own 503
 * response already carries a specific, actionable `error` field (e.g.
 * "APP_ENV is not set") -- previously pollHealth's timeout error only
 * reported commitSha/ok/environment, leaving an operator whose deployment
 * was healthy in every way EXCEPT a missing APP_ENV looking at the exact
 * same "not yet" message as one that simply hadn't finished building.
 * finalize's own health poll can never succeed without APP_ENV set (see
 * app/api/health/route.ts's cannotEstablishIdentity case) -- surfacing its
 * diagnostic text is the difference between "wait longer" and "go set this
 * one thing in Vercel."
 */
describe("pollHealth surfaces /api/health's own diagnostic error text on a failed poll", () => {
  const EXPECTED_SHA = "a".repeat(40);
  let servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function urlFor(server: http.Server) {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/api/health`;
  }

  it("includes /api/health's own APP_ENV-missing error text in the timeout message", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          environment: "unknown",
          commitSha: null,
          commitRef: null,
          error:
            'This is a production-mode build (NODE_ENV=production) but APP_ENV is not set -- expected "production" or "preview". Set APP_ENV directly in Vercel Project Settings -> Environment Variables.',
        }),
      );
    });
    await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 1)).rejects.toThrow(/APP_ENV/);
  }, 10000);
});

/**
 * Found during an independent adversarial review of the third round's own
 * diff: runPrepare -- this round's rewrite of the highest-risk part of the
 * rollout tooling (replacing crash-unsafe renameSync file-staging with a
 * copy-based temporary workspace, see runPrepare's own header comment) --
 * had ZERO automated coverage. `execFileSync` (the only I/O the mocked
 * `supabase` CLI calls go through) is mocked exactly like the runFinalize
 * tests above; the filesystem assembly itself (mkdtempSync/mkdirSync/
 * copyFileSync) is real, unmocked I/O against the OS temp directory and
 * this repository's own REAL supabase/migrations/ directory (read-only),
 * so these tests exercise the actual copy logic, not a simulation of it.
 * The mocked `db push` implementation snapshots the assembled workdir's
 * contents itself, synchronously, before returning -- runPrepare deletes
 * that directory in its own `finally` moments later, so this is the only
 * point a test can observe what was actually assembled.
 */
describe("runPrepare assembles a real temporary workspace and never touches the real migrations directory", () => {
  const REAL_MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");
  const EXPAND_FILES = [
    "20260907150000_add_organization_billing.sql",
    "20260907160000_fix_organization_billing_grandfathering_and_event_ordering.sql",
  ];
  const ENFORCE_FILES = ["20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql"];

  let capturedWorkdirMigrations: string[] | null;
  let capturedWorkdirHasConfig: boolean | null;
  let capturedPushArgs: string[] | null;
  let migrationListCallCount: number;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    capturedWorkdirMigrations = null;
    capturedWorkdirHasConfig = null;
    capturedPushArgs = null;
    migrationListCallCount = 0;

    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv.includes("migration") && argv.includes("list")) {
        migrationListCallCount += 1;
        // Call 1 (before push): a fresh state -- both expand and enforce
        // files are pending. Call 2 (the final verification, after the
        // mocked push): only --enforce remains, simulating that the push
        // genuinely applied the expand files for real.
        const pendingVersions =
          migrationListCallCount === 1
            ? [...EXPAND_FILES, ...ENFORCE_FILES]
            : [...ENFORCE_FILES];
        return JSON.stringify({
          migrations: pendingVersions.map((f) => ({ local: f.split("_")[0], remote: "" })),
        });
      }
      if (argv.includes("push")) {
        capturedPushArgs = argv;
        const workdirIndex = argv.indexOf("--workdir");
        if (workdirIndex !== -1) {
          const workdir = argv[workdirIndex + 1];
          capturedWorkdirHasConfig = existsSync(path.join(workdir, "supabase", "config.toml"));
          capturedWorkdirMigrations = existsSync(path.join(workdir, "supabase", "migrations"))
            ? readdirSync(path.join(workdir, "supabase", "migrations")).sort()
            : null;
        }
        return "";
      }
      throw new Error(`Unexpected execFileSync call in this test: ${JSON.stringify(argv)}`);
    });
  });

  function baseArgs(overrides: Record<string, unknown> = {}) {
    return {
      target: "production",
      environment: "production",
      allowedOrigin: "https://example.com",
      supabaseProjectRef: "ref",
      dbUrl: "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres",
      expand: EXPAND_FILES,
      enforce: ENFORCE_FILES,
      dryRun: false,
      ...overrides,
    };
  }

  it("assembles a workdir containing every --expand file and config.toml, excluding every --enforce file", () => {
    runPrepare(baseArgs());
    expect(capturedWorkdirHasConfig).toBe(true);
    expect(capturedWorkdirMigrations).not.toBeNull();
    for (const file of EXPAND_FILES) {
      expect(capturedWorkdirMigrations).toContain(file);
    }
    for (const file of ENFORCE_FILES) {
      expect(capturedWorkdirMigrations).not.toContain(file);
    }
  });

  it("points supabase db push at the temporary workdir, not the real supabase/migrations directory", () => {
    runPrepare(baseArgs());
    expect(capturedPushArgs).not.toBeNull();
    const workdirIndex = capturedPushArgs!.indexOf("--workdir");
    expect(workdirIndex).toBeGreaterThanOrEqual(0);
    const workdir = capturedPushArgs![workdirIndex + 1];
    expect(path.resolve(workdir)).not.toBe(path.resolve(REAL_MIGRATIONS_DIR, ".."));
    expect(capturedPushArgs).toContain("--include-all");
    expect(capturedPushArgs).toContain("--yes");
  });

  it("never modifies the real supabase/migrations/ directory -- identical contents before and after", () => {
    const before = readdirSync(REAL_MIGRATIONS_DIR).sort();
    runPrepare(baseArgs());
    const after = readdirSync(REAL_MIGRATIONS_DIR).sort();
    expect(after).toEqual(before);
    // Specifically confirms the --enforce file was never removed from (or
    // added to) the real directory -- the exact property the old
    // renameSync-based design could violate on a crash.
    expect(after).toContain(ENFORCE_FILES[0]);
  });

  it("cleans up the temporary workdir after a successful run -- nothing left behind", () => {
    runPrepare(baseArgs());
    expect(capturedWorkdirMigrations).not.toBeNull();
    const workdirIndex = capturedPushArgs!.indexOf("--workdir");
    const workdir = capturedPushArgs![workdirIndex + 1];
    expect(existsSync(workdir)).toBe(false);
  });

  it("uses --dry-run instead of --yes, and still assembles/cleans up the workspace, when args.dryRun is set", () => {
    runPrepare(baseArgs({ dryRun: true }));
    expect(capturedPushArgs).toContain("--dry-run");
    expect(capturedPushArgs).not.toContain("--yes");
    expect(capturedWorkdirMigrations).not.toBeNull();
    const workdirIndex = capturedPushArgs!.indexOf("--workdir");
    const workdir = capturedPushArgs![workdirIndex + 1];
    expect(existsSync(workdir)).toBe(false);
  });

  it("skips the entire workspace-assembly step (never calls push, never touches the temp directory) when --expand is empty", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv.includes("migration") && argv.includes("list")) {
        return JSON.stringify({ migrations: [] });
      }
      throw new Error(`Unexpected execFileSync call: ${JSON.stringify(argv)} -- push should never be reached`);
    });
    runPrepare(baseArgs({ expand: [], enforce: [] }));
    expect(capturedPushArgs).toBeNull();
  });

  it("still cleans up the temporary workdir even when the push itself throws", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv.includes("migration") && argv.includes("list")) {
        return JSON.stringify({
          migrations: [...EXPAND_FILES, ...ENFORCE_FILES].map((f) => ({ local: f.split("_")[0], remote: "" })),
        });
      }
      if (argv.includes("push")) {
        const workdirIndex = argv.indexOf("--workdir");
        capturedWorkdirMigrations = ["captured-before-throw"];
        const workdir = argv[workdirIndex + 1];
        // Record the workdir path for the post-throw existence check below,
        // then simulate the push itself failing.
        capturedPushArgs = argv;
        expect(existsSync(workdir)).toBe(true);
        const err = new Error("simulated db push failure") as Error & { status: number; stdout: string; stderr: string };
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      throw new Error(`Unexpected execFileSync call: ${JSON.stringify(argv)}`);
    });

    expect(() => runPrepare(baseArgs())).toThrow();
    const workdirIndex = capturedPushArgs!.indexOf("--workdir");
    const workdir = capturedPushArgs![workdirIndex + 1];
    expect(existsSync(workdir)).toBe(false);
  });
});

/**
 * Found during a second independent review: pollHealth's fetch() carried
 * no timeout/abort signal at all -- a single hanging response (a
 * half-open connection, a misbehaving proxy or load balancer, a server
 * that accepts the connection but never replies) could block for the
 * ENTIRE remaining deploy timeout on one request, defeating the retry
 * loop this function exists to run at all: instead of many short, cheap
 * retries against a genuinely still-deploying target, an operator would
 * silently wait out the whole --deploy-timeout-seconds budget stuck on a
 * single unresponsive request with zero further attempts. Fixed with
 * AbortSignal.timeout(), capped by whatever's actually left of the
 * overall deadline.
 */
describe("pollHealth aborts a hanging request instead of blocking the whole retry loop on it", () => {
  const EXPECTED_SHA = "a".repeat(40);
  let servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function urlFor(server: http.Server) {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/api/health`;
  }

  it(
    "a request that hangs forever (accepts the connection, never responds) is aborted -- pollHealth fails within its own timeout budget, not indefinitely",
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately never calls res.write()/res.end() to simulate a half-open connection or a server that accepts but never replies
      const server = await startServer((_req, _res) => {});
      const start = Date.now();
      await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 2)).rejects.toThrow(/Timed out/);
      const elapsedMs = Date.now() - start;
      // If the abort signal never fired, this request would instead hang
      // for however long the underlying socket/Node default allows --
      // typically far longer than this, when it resolves at all. Bounding
      // this loosely (well above the 2s pollHealth timeout plus one 5s
      // retry-interval sleep) is enough to prove the hang was actually cut
      // short, not that it happened to resolve quickly by chance.
      expect(elapsedMs).toBeLessThan(15_000);
    },
    20000,
  );
});

/**
 * Fourth independent review, Finding 14: a third review's own fix for the
 * hanging-request problem above (AbortSignal.timeout, capped by whatever's
 * left of the deadline) still carried a real bug -- `perRequestTimeoutMs`
 * was computed as `Math.max(1000, remainingMs)`, a one-second FLOOR applied
 * even when far less than a second genuinely remained. With under a second
 * left on the overall deadline, a still-hanging server would only be
 * aborted after the full padded 1000ms, not the smaller amount actually
 * left -- so pollHealth (and therefore runFinalize, and therefore the
 * rollout script's own --deploy-timeout-seconds contract) could return
 * (or throw "Timed out") measurably LATER than the timeoutSeconds it was
 * given. The test above never caught this: its 2s timeout starts with
 * remaining ~= the full budget, so a 1s floor is indistinguishable from
 * "no floor" on the very first request -- the bug only bites once
 * remaining has shrunk below the floor's own value, which a >=1s deadline
 * never exercises on its first (and, given the fixed 5s retry sleep,
 * usually only) iteration.
 *
 * This test uses a sub-second deadline (50ms) specifically so the very
 * first request already starts with well under a second remaining --
 * exactly the condition the buggy floor mishandled. The fixed
 * implementation (Math.min(30_000, remainingMs), no floor) must abort and
 * throw close to 50ms; the old Math.max(1000, remainingMs) code would have
 * taken close to 1000ms instead -- a 20x difference, not something normal
 * CI scheduling jitter could produce by accident.
 */
describe("Finding 14: pollHealth never waits past its own deadline, even with well under a second remaining", () => {
  const EXPECTED_SHA = "a".repeat(40);
  let servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function urlFor(server: http.Server) {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/api/health`;
  }

  it("aborts a hanging request within its actual sub-second deadline, not padded up to a fixed 1s floor", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately never responds, so only the deadline (not the server) determines how long this takes
    const server = await startServer((_req, _res) => {});
    const start = Date.now();
    // A 0.05s (50ms) overall deadline -- the first loop iteration's
    // `remainingMs` is already well under the old code's 1000ms floor.
    await expect(pollHealth(urlFor(server), EXPECTED_SHA, "production", 0.05)).rejects.toThrow(/Timed out/);
    const elapsedMs = Date.now() - start;
    // The buggy Math.max(1000, remainingMs) version would land close to
    // 1000ms here. A generous-but-decisive 400ms ceiling (8x the nominal
    // 50ms deadline, comfortably absorbing CI scheduling jitter) passes
    // under the fix and fails under the old floor -- the two are an order
    // of magnitude apart, not a close call.
    expect(elapsedMs).toBeLessThan(400);
  });
});

/**
 * Found during an independent review, after the prepare/finalize split
 * above had already shipped: runFinalize used to return immediately, as a
 * success, the moment validateFinalizePlan reported nothing pending --
 * without ever polling /api/health. An empty "remaining" set only proves
 * the DATABASE side is done; it proves nothing about whether the
 * application actually running in production is the one that was meant to
 * be there. That gap meant an operator who ran finalize with the wrong
 * --expected-sha (a typo, or a stale value copied from an earlier
 * attempt), or against a database where the enforce migrations became
 * applied some other way entirely (an out-of-band change, or a genuinely
 * completed prior run for a DIFFERENT release), still saw finalize print
 * success -- with the live deployment never actually checked against what
 * was asked for this time. These tests use real local HTTP servers for
 * the health endpoint (matching the R7-04 tests above, not a mocked
 * fetch), and mock only execFileSync (the `supabase migration list` call)
 * to report nothing pending, so runFinalize takes the exact
 * nothing-to-apply path this finding is about.
 */
describe("runFinalize verifies live health even when nothing is pending to apply", () => {
  const REAL_ENFORCE_FILE = "20260907160000_fix_organization_billing_grandfathering_and_event_ordering.sql";
  const EXPECTED_SHA = "a".repeat(40);
  let servers: http.Server[] = [];

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    // Nothing pending at all -- simulating "the enforce migrations are
    // already applied," the exact state that used to short-circuit
    // straight to success.
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ migrations: [] }));
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function urlFor(server: http.Server) {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/api/health`;
  }

  function baseArgs(healthUrl: string, expectedSha: string, deployTimeoutSeconds: number) {
    return {
      target: "production",
      environment: "production",
      allowedOrigin: "https://example.com",
      healthUrl,
      supabaseProjectRef: "ref",
      dbUrl: `postgresql://postgres:pw@db.ref.supabase.co:5432/postgres`,
      enforce: [REAL_ENFORCE_FILE],
      expectedSha,
      deployTimeoutSeconds,
      drainSeconds: 0,
      dryRun: false,
    };
  }

  it(
    "refuses to report success when nothing is pending but the live deployment does NOT match --expected-sha",
    async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        // A real, live deployment -- just not the one --expected-sha names.
        res.end(JSON.stringify({ ok: true, commitSha: "b".repeat(40), environment: "production" }));
      });
      await expect(runFinalize(baseArgs(urlFor(server), EXPECTED_SHA, 1))).rejects.toThrow(/Timed out/);
    },
    10000,
  );

  it(
    "refuses to report success when nothing is pending but /api/health itself is unreachable",
    async () => {
      // A port nothing is listening on -- the health check must fail, not
      // be skipped.
      await expect(runFinalize(baseArgs("http://127.0.0.1:1/api/health", EXPECTED_SHA, 1))).rejects.toThrow(
        /Timed out/,
      );
    },
    10000,
  );

  it(
    "succeeds when nothing is pending AND the live deployment genuinely matches --expected-sha -- confirming a real prior success is still recognized as one",
    async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, commitSha: EXPECTED_SHA, environment: "production" }));
      });
      let requestCount = 0;
      server.on("request", () => {
        requestCount += 1;
      });
      await expect(runFinalize(baseArgs(urlFor(server), EXPECTED_SHA, 5))).resolves.toBeUndefined();
      // Drain/smoke-check/apply are all specific to actually applying a
      // migration -- with nothing to apply, exactly one health check
      // should run (step 2), not the extra smoke-check poll step 4 would
      // add for a real apply.
      expect(requestCount).toBe(1);
    },
    10000,
  );
});
