import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The general form of round-14 R14-02, guarded in a test that needs no
 * database and therefore actually runs.
 *
 * R14-02 was: two migrations both `create or replace` the same function, one in
 * `--expand` and one held back to `--enforce`. Enforce runs last, so the
 * documented rollout ended with an OLDER definition than a sorted replay --
 * silently reinstating a bug an earlier round had fixed. Forty-eight green
 * harness checks never saw it, because every one of them replays in FILENAME
 * order, which is not the order production will use.
 *
 * Fixing the instance (a restore migration appended last in enforce) does not
 * fix the class. A future migration that redefines any object another
 * migration also defines, in the other phase, reintroduces it -- and the
 * failure is silent, because both orders apply cleanly and only the end state
 * differs.
 *
 * So the invariant asserted here is not "no object may be defined twice" --
 * that is normal and fine -- but: **whichever migration defines an object LAST
 * in the staged rollout order must be the same one that defines it last in
 * sorted order.** That is precisely what R14-02 violated, and it is checkable
 * from the manifest and the migration files alone.
 *
 * `scripts/verify-local-database.mjs` also gained a staged-order replay that
 * asserts the resulting schema directly. That one is stronger and needs a real
 * PostgreSQL; this one is weaker and always runs. Both exist on purpose.
 */

const MIGRATIONS_DIR = path.join(app, "supabase/migrations");
// Production's current migration count; everything after it is pending.
// Was 17 until the 2026-09-14 rollout applied 18 through 51.
const DEPLOYED_THROUGH = 51;

/**
 * That 2026-09-14 rollout, frozen: migrations 18-51, with exactly these three
 * held back to --enforce. The non-vacuity check below replays it, so it keeps
 * proving it could catch R14-02 now that the live manifest has moved on.
 */
const HISTORICAL_ROLLOUT = {
  deployedBefore: 17,
  deployedThrough: 51,
  enforce: [
    "20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql",
    "20260906100000_drop_ambiguous_request_notification_email_change_overload.sql",
    "20260914120000_restore_locked_confirm_notification_email_change.sql"
  ],
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function manifestPhase(flag: "expand" | "enforce"): string[] {
  const doc = readFileSync(path.join(app, "DEPLOYMENT.md"), "utf8");
  const prefix = `--${flag} `;
  const line = doc
    .split(String.fromCharCode(10))
    .map((l) => l.replace(String.fromCharCode(13), "").trim())
    .find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`DEPLOYMENT.md has no ${prefix}manifest line`);
  return line
    .slice(prefix.length)
    .replace("\\", "")
    .trim()
    // An empty phase is written `--enforce ""`, which rollout.mjs accepts.
    .replace(/^""$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Objects a migration (re)defines. Comment lines are stripped first, because
 * every migration in this repository quotes the SQL it is replacing in its own
 * header -- matching those would make this check fire on prose.
 */
function definedObjects(file: string): string[] {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith("--"))
    .join(String.fromCharCode(10));

  const found: string[] = [];
  const patterns: [RegExp, string][] = [
    [/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(/gi, "function"],
    [/create\s+(?:or\s+replace\s+)?view\s+([a-z_]+\.[a-z_]+)/gi, "view"],
    [/create\s+(?:or\s+replace\s+)?trigger\s+([a-z_]+)\s/gi, "trigger"],
  ];
  for (const [re, kind] of patterns) {
    for (const m of sql.matchAll(re)) found.push(`${kind} ${m[1]}`);
  }
  // Policies are name-scoped to their table, so both parts matter.
  for (const m of sql.matchAll(/create\s+policy\s+([a-z_]+)\s+on\s+([a-z_]+\.[a-z_]+)/gi)) {
    found.push(`policy ${m[1]} on ${m[2]}`);
  }
  return [...new Set(found)];
}

describe("the rollout manifest", () => {
  const files = migrationFiles();
  const pending = files.slice(DEPLOYED_THROUGH);
  const expand = manifestPhase("expand");
  const enforce = manifestPhase("enforce");

  it("covers exactly the pending migrations, no more and no fewer", () => {
    // A manifest that has drifted from the directory makes every other check
    // here an assertion about a fiction.
    expect([...expand, ...enforce].sort()).toEqual([...pending].sort());
  });

  it("lists each migration in exactly one phase", () => {
    const both = expand.filter((f) => enforce.includes(f));
    expect(both).toEqual([]);
  });

  it("ends every redefined object on the same migration a sorted replay would", () => {
    const stagedOrder = [...files.slice(0, DEPLOYED_THROUGH), ...expand, ...enforce];
    const sortedOrder = files;

    const lastDefiner = (order: string[]) => {
      const last = new Map<string, string>();
      for (const file of order) {
        for (const object of definedObjects(file)) last.set(object, file);
      }
      return last;
    };

    const staged = lastDefiner(stagedOrder);
    const sorted = lastDefiner(sortedOrder);

    const divergent: string[] = [];
    for (const [object, sortedFile] of sorted) {
      const stagedFile = staged.get(object);
      if (stagedFile !== sortedFile) {
        divergent.push(`${object}: staged rollout ends at ${stagedFile}, sorted replay ends at ${sortedFile}`);
      }
    }

    // Round-14 R14-02 is exactly one entry in this list. If it reappears, the
    // message names the object and both migrations, because "the manifest is
    // wrong" is not actionable on its own.
    expect(divergent).toEqual([]);
  });

  it("would have caught R14-02 -- the check is not vacuous", () => {
    // Proves the comparison above can actually fail, by replaying the frozen
    // 2026-09-14 rollout with the restore migration removed from enforce:
    // that is the state the repository was in when the reviewer found it.
    const { deployedBefore, deployedThrough, enforce: historicalEnforce } = HISTORICAL_ROLLOUT;
    const upTo = files.slice(0, deployedThrough);
    const historicalExpand = upTo.slice(deployedBefore).filter((f) => !historicalEnforce.includes(f));
    const withoutRestore = historicalEnforce.filter(
      (f) => !f.includes("restore_locked_confirm_notification_email_change"),
    );
    expect(withoutRestore.length, "the restore migration is no longer in the frozen enforce list").toBe(
      historicalEnforce.length - 1,
    );

    const lastDefiner = (order: string[]) => {
      const last = new Map<string, string>();
      for (const file of order) {
        for (const object of definedObjects(file)) last.set(object, file);
      }
      return last;
    };
    const sorted = lastDefiner(upTo);
    const target = "function public.confirm_notification_email_change";

    // The rollout as actually run agrees with a sorted replay ...
    const asRun = lastDefiner([...upTo.slice(0, deployedBefore), ...historicalExpand, ...historicalEnforce]);
    expect(asRun.get(target)).toBe(sorted.get(target));

    // ... and without the restore migration it would not have.
    const broken = lastDefiner([...upTo.slice(0, deployedBefore), ...historicalExpand, ...withoutRestore]);
    expect(broken.get(target)).not.toBe(sorted.get(target));
  });
});
