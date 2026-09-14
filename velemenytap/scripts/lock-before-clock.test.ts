import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(app, "supabase/migrations");

/**
 * The clock-before-lock class, found SEVEN times in this project across six
 * rounds -- most recently round-14 R14-03, in a function round 12 had just
 * written. `20260910120000`'s header lists the earlier instances.
 *
 * The shape: a statement decides something from `now()`/`clock_timestamp()` in
 * its own WHERE clause, and that statement can wait for a row lock. The
 * qualification is evaluated during the scan, BEFORE the wait. PostgreSQL
 * re-checks it afterwards only when the tuple was actually updated
 * (EvalPlanQual follows `t_ctid`), so a holder that merely took
 * `SELECT ... FOR UPDATE` leaves the pre-wait clock reading standing -- and the
 * statement acts on a deadline that has already passed.
 *
 * Every instance so far was found by a human reading SQL, one at a time, after
 * it shipped. This is that reading, automated, over the CURRENT definition of
 * every function in the repository -- so instance eight has to get past a test
 * rather than past a reviewer's attention.
 *
 * It is deliberately a lint, not a proof. It cannot know whether a given wait
 * is reachable, and it will not catch a version that reads the clock into a
 * variable before locking. What it does catch is the exact textual shape all
 * seven instances had, which is worth more than nothing and costs no database.
 */

type FunctionDefinition = { name: string; file: string; body: string };

function currentFunctionDefinitions(): FunctionDefinition[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Only the last definition of each function is live; earlier ones were
  // replaced. Auditing a replaced body would report defects that no longer
  // exist -- and, worse, distract from one that does.
  const latest = new Map<string, FunctionDefinition>();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("--"))
      .join(String.fromCharCode(10));
    const re = /create\s+(?:or\s+replace\s+)?function\s+(public\.[a-z_]+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi;
    for (const m of sql.matchAll(re)) latest.set(m[1], { name: m[1], file, body: m[2] });
  }
  return [...latest.values()];
}

/** The statements that can wait on a row lock, and decide from the clock. */
function timeQualifiedMutations(body: string): string[] {
  const lower = body.toLowerCase();
  const mutating = [...lower.matchAll(/\b(update|delete\s+from)\b[\s\S]*?(?=;)/g)].map((m) => m[0]);
  return mutating.filter((statement) => {
    const where = statement.split(/\bwhere\b/)[1];
    return Boolean(where) && /(clock_timestamp\(\)|\bnow\(\))/.test(where);
  });
}

function locksBeforeMutating(body: string): boolean {
  const lower = body.toLowerCase();
  const lockAt = lower.indexOf("for update");
  if (lockAt < 0) return false;
  const first = timeQualifiedMutations(body)[0];
  return first ? lockAt < lower.indexOf(first) : true;
}

describe("lock before clock", () => {
  it("no live function decides a mutation from the clock without locking first", () => {
    const offenders = currentFunctionDefinitions()
      .filter((fn) => timeQualifiedMutations(fn.body).length > 0 && !locksBeforeMutating(fn.body))
      .map((fn) => `${fn.name} (${fn.file})`);

    // Naming the function and the migration matters: "some function is wrong"
    // sends the next person back through 51 files.
    expect(offenders).toEqual([]);
  });

  it("catches the round-14 R14-03 shape -- the check is not vacuous", () => {
    // The pre-fix definition, still present in migration 47's file even though
    // migration 50 replaced it. If this ever stops being flagged, the audit
    // above has stopped meaning anything.
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, "20260911100000_checkout_request_sent_state.sql"),
      "utf8",
    )
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("--"))
      .join(String.fromCharCode(10));

    const re = /create\s+(?:or\s+replace\s+)?function\s+(public\.[a-z_]+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi;
    const preFix = [...sql.matchAll(re)].find((m) => m[1] === "public.mark_checkout_request_sent");
    expect(preFix, "migration 47's original marker is no longer readable").toBeDefined();

    const body = preFix![2];
    expect(timeQualifiedMutations(body).length).toBeGreaterThan(0);
    expect(locksBeforeMutating(body)).toBe(false);
  });
});
