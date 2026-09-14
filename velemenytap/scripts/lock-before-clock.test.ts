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
 * Two shapes are checked, because the class has appeared as both:
 *
 *   1. the clock in the WHERE of a statement that can wait (round-14 R14-03);
 *   2. the clock read into a variable BEFORE a lock the function then waits on,
 *      so every later comparison uses a moment that may be long past
 *      (round-10 R10-06/R10-07).
 *
 * It is deliberately a lint, not a proof, and round 15 asked for its scope to
 * be stated rather than implied. It reads only `public.` function definitions,
 * only the LAST one per NAME (so overloads collapse and drops are not
 * modelled), and it excludes `private.` trigger functions entirely. Seeing the
 * first `FOR UPDATE` does not prove that every later mutation's target row is
 * the one locked. Declaration-time defaults, indirect clock reads, foreign-key
 * waits and advisory-lock waits all still need a human. What it does catch is
 * the exact textual shape every instance so far has had, at no database cost --
 * which is what makes it run in CI, unlike the harness gate.
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

/**
 * The second shape, and the one the WHERE-clause check above cannot see:
 *
 *     v_now := clock_timestamp();          -- read here
 *     select ... from t where ... for update;  -- waits here
 *     if v_now > ... then                  -- decided on a stale reading
 *
 * This is round-10 R10-06/R10-07. The clock is captured before a wait that can
 * last arbitrarily long, so every decision after the lock is judged against a
 * moment that may be long past. Nothing is in a WHERE, so shape one misses it
 * entirely.
 */
function readsClockBeforeLocking(body: string): boolean {
  const lower = body.toLowerCase();
  const lockAt = lower.indexOf("for update");
  if (lockAt < 0) return false;
  const assignment = new RegExp(":=\\s*(clock_timestamp\\(\\)|now\\(\\))", "g");
  return [...lower.matchAll(assignment)].some((m) => (m.index ?? 0) < lockAt);
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

  it("no live function reads the clock before taking the lock it then waits on", () => {
    const offenders = currentFunctionDefinitions()
      .filter((fn) => readsClockBeforeLocking(fn.body))
      .map((fn) => `${fn.name} (${fn.file})`);

    expect(offenders).toEqual([]);
  });

  it("catches the round-10 shape too -- on a SYNTHETIC fixture, not a real one", () => {
    // Unlike shape one below, no pre-fix example of this survives in the
    // repository: the migrations that had it were replaced, and their old
    // bodies live only in comment headers, which are stripped before scanning.
    // So this fixture is constructed rather than historical, and says so --
    // it proves the predicate works, not that it ever fired on real code here.
    const stale = `
      declare v_now timestamptz;
      begin
        v_now := clock_timestamp();
        select * from public.organization_billing where organization_id = p_id for update;
        if v_now > something then return false; end if;
      end;`;
    expect(readsClockBeforeLocking(stale)).toBe(true);

    const correct = `
      declare v_now timestamptz;
      begin
        select * from public.organization_billing where organization_id = p_id for update;
        v_now := clock_timestamp();
        if v_now > something then return false; end if;
      end;`;
    expect(readsClockBeforeLocking(correct)).toBe(false);
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
