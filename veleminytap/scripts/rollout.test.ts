import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import {
  parseArgs,
  validateMigrationPlan,
  loadEnvironments,
  projectRefFromDbUrl,
  sh,
  redactConnectionStrings,
  credentialSecretsFromArgs,
  pollHealth,
  getPendingMigrations,
} from "./rollout.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const TEST_REF = "abcdefghijklmnopqrst";
const TEST_ENVIRONMENTS = loadEnvironments(
  JSON.stringify({
    production: {
      supabaseProjectRef: TEST_REF,
      allowedOrigin: "https://velemenytap.vercel.app",
      healthUrl: "https://velemenytap.vercel.app/api/health",
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

describe("parseArgs", () => {
  it("parses a fully valid argument set", () => {
    const args = parseArgs(VALID_ARGV, TEST_ENVIRONMENTS);
    expect(args.expand).toEqual(["20260101000000_a.sql"]);
    expect(args.enforce).toEqual(["20260102000000_b.sql"]);
    expect(args.expectedSha).toBe(VALID_SHA);
    expect(args.dryRun).toBe(false);
    expect(args.target).toBe("production");
    expect(args.allowedOrigin).toBe("https://velemenytap.vercel.app");
    expect(args.healthUrl).toBe("https://velemenytap.vercel.app/api/health");
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

    /**
     * Round-7 finding R7-04: this used to silently ACCEPT and ignore
     * --allowed-origin/--health-url (they were parsed into `raw` but
     * nothing ever read them out again) -- a caller who believed they were
     * still setting a safety-related flag got no error and no effect.
     * Unknown flags, these two specifically included, are now rejected
     * outright.
     */
    it("rejects the removed --allowed-origin flag outright, not silently", () => {
      const argv = [...VALID_ARGV, "--allowed-origin", "https://attacker.example.com"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --allowed-origin[\s\S]*removed/);
    });

    it("rejects the removed --health-url flag outright, not silently", () => {
      const argv = [...VALID_ARGV, "--health-url", "https://attacker.example.com/api/health"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --health-url[\s\S]*removed/);
    });

    it("rejects any other unrecognized flag too", () => {
      const argv = [...VALID_ARGV, "--totally-made-up-flag", "value"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/Unknown argument --totally-made-up-flag/);
    });

    it("rejects a bare positional argument that isn't a --flag", () => {
      const argv = [...VALID_ARGV, "some-stray-value"];
      expect(() => parseArgs(argv, TEST_ENVIRONMENTS)).toThrow(/every argument must be a --flag/);
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
  const DB_URL = `postgresql://${USERNAME_CANARY}:${PASSWORD_CANARY}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;

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
      const text = `Connection failed: ${DB_URL}`;
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
      const secrets = credentialSecretsFromArgs(["supabase", "db", "push", "--db-url", DB_URL]);
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
        message: `Command failed: npx supabase migration list --db-url ${DB_URL} --output-format json`,
        stderr: `connection to server failed: ${DB_URL}`,
      });
      let caught: (Error & { stdout?: string; stderr?: string }) | undefined;
      try {
        sh("npx", ["supabase", "migration", "list", "--db-url", DB_URL, "--output-format", "json"]);
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
        message: `Command failed: npx supabase db push --db-url ${DB_URL} --include-all --yes`,
        stdout: `applying migration...\nfailed: ${DB_URL}`,
        stderr: `password authentication failed for user "${USERNAME_CANARY}"`,
      });
      let caught: (Error & { stdout?: string; stderr?: string }) | undefined;
      try {
        sh("npx", ["supabase", "db", "push", "--db-url", DB_URL, "--include-all", "--yes"]);
      } catch (err) {
        caught = err as Error & { stdout?: string; stderr?: string };
      }
      expect(caught).toBeDefined();
      const serialized = JSON.stringify({ message: caught?.message, stdout: caught?.stdout, stderr: caught?.stderr });
      expect(serialized).not.toContain(PASSWORD_CANARY);
      expect(serialized).not.toContain(USERNAME_CANARY);
    });

    it("does not carry forward any un-sanitized property (e.g. .output) from the original error", () => {
      const err = new Error(`Command failed: ... ${DB_URL}`) as Error & { status: number; output: unknown[] };
      err.status = 1;
      err.output = [null, `stdout with ${DB_URL}`, `stderr with ${DB_URL}`];
      vi.mocked(execFileSync).mockImplementation(() => {
        throw err;
      });
      let caught: (Error & { output?: unknown }) | undefined;
      try {
        sh("npx", ["supabase", "db", "push", "--db-url", DB_URL]);
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
      vi.mocked(execFileSync).mockReturnValue(`some banner mentioning ${DB_URL} then no json`);
      expect(() => getPendingMigrations(DB_URL)).toThrow(/Expected JSON/);
      try {
        getPendingMigrations(DB_URL);
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
