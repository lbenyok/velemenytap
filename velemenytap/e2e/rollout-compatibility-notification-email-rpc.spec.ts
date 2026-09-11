import { test, expect } from "@playwright/test";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectToTestDb } from "./support/db-connection";
import { adminClient } from "./support/seed";

/**
 * Finding 1 (second independent review, 2026-09-07): the documented
 * rollout applied a new 2-argument request_notification_email_change(...)
 * during `prepare` while production's already-deployed 3-argument
 * request_notification_email_change(bigint, text, int default 1440) was
 * still live, and only dropped the 3-argument one later, during
 * `finalize`. Both are reachable with the app's only-ever-used call shape
 * -- two named arguments, (p_organization_id, p_email) -- so PostgREST
 * could not choose an overload and returned PGRST203 for EVERY caller,
 * old and new code alike, for the entire window between those two steps.
 * The fix was to give the new function a distinct name
 * (reserve_notification_email_change) so it can never collide with the
 * legacy one at any point in the rollout -- see supabase/migrations/
 * 20260905193325's header comment for the full incident and DECISIONS.md
 * for the corrected design.
 *
 * This spec proves the FIX'S MECHANISM directly and executably, against
 * the real isolated Supabase project's actual PostgREST layer -- not a
 * restatement of the reasoning in prose, and not a simulation. It uses
 * throwaway, uniquely-prefixed functions (never touching real application
 * objects) to stand in for the three real rollout states in sequence:
 *
 *   1. "migrations 1-17" (production baseline): only the legacy
 *      3-argument-with-default function exists.
 *   2. "after prepare" (expand applied, before deploy/finalize): the new
 *      function now ALSO exists, under its own distinct name.
 *   3. "after finalize" (enforce applied): the legacy function is gone.
 *
 * At every one of these states, calling with the app's actual two-named-
 * argument shape must resolve unambiguously to the right function -- never
 * PGRST203. A leading negative control creates the ORIGINAL, buggy
 * same-name pairing and asserts PGRST203 actually happens for it, proving
 * this spec would catch a regression back to the old design, not just
 * pass vacuously.
 *
 * Needs a direct Postgres connection (SUPABASE_DB_URL) to create/drop the
 * throwaway functions -- DDL isn't reachable through PostgREST/supabase-js.
 * Skips gracefully locally without one; mandatory in CI like every other
 * spec that needs this connection (round-4 R4-04, e2e/support/db-
 * connection.ts).
 */

const LEGACY_NAME = "_rollout_compat_test_request_email_change";
const NEW_NAME = "_rollout_compat_test_reserve_email_change";

async function dropAll(client: Client) {
  await client.query(`drop function if exists public.${LEGACY_NAME}(bigint, text, int)`);
  await client.query(`drop function if exists public.${LEGACY_NAME}(bigint, text)`);
  await client.query(`drop function if exists public.${NEW_NAME}(bigint, text)`);
}

async function createLegacy3Arg(client: Client, name: string) {
  await client.query(`
    create function public.${name}(p_organization_id bigint, p_email text, p_expires_in_minutes int default 1440)
    returns text language sql as $$ select 'legacy' $$
  `);
}

async function createNew2Arg(client: Client, name: string) {
  await client.query(`
    create function public.${name}(p_organization_id bigint, p_email text)
    returns text language sql as $$ select 'new' $$
  `);
}

/**
 * PostgREST reloads its schema cache on DDL asynchronously (Supabase's
 * hosted event trigger fires it, but propagation isn't instantaneous) --
 * retries briefly while the response still reflects a STALE cache rather
 * than requiring the caller to guess a fixed delay:
 *   - waiting for a function to become callable: PGRST202 ("not in the
 *     schema cache yet") is the stale signal to retry past.
 *   - waiting for a function to become UNcallable after a DROP: a stale
 *     cache can still believe it exists and forward the call straight to
 *     Postgres, which then reports 42883 (undefined_function) directly --
 *     that raw Postgres code, not PGRST202, is what a just-dropped
 *     function actually returns before the cache itself catches up and
 *     starts reporting the miss as PGRST202 on its own terms.
 *   - waiting for a function to become UNambiguously callable again after
 *     an EARLIER test in this same file dropped a second overload of the
 *     same name moments ago: a stale cache can still remember that second
 *     overload and report PGRST203 (ambiguous) even though the real
 *     database is already back to a single, unambiguous candidate --
 *     retried past for the same reason as PGRST202 above.
 */
async function callEventually(
  admin: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  options: { expectMissing?: boolean; expectAmbiguous?: boolean } = {},
) {
  const { expectMissing = false, expectAmbiguous = false } = options;
  const deadline = Date.now() + 15_000;
  let last: { data: unknown; error: { code?: string; message?: string } | null };
  for (;;) {
    last = await admin.rpc(name, args);
    const stillPropagating = expectMissing
      ? last.error === null || last.error.code === "42883"
      : expectAmbiguous
        ? last.error === null || last.error.code === "PGRST202"
        : last.error?.code === "PGRST202" || last.error?.code === "PGRST203";
    if (!stillPropagating || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

test.describe("Finding 1 rollout compatibility: a distinctly-named RPC never collides across the expand/enforce window", () => {
  let client: Client | null;

  test.beforeAll(async () => {
    client = await connectToTestDb();
  });

  test.afterAll(async () => {
    if (client) {
      await dropAll(client);
      await client.end();
    }
  });

  test.beforeEach(async () => {
    if (client) await dropAll(client);
  });

  test("NEGATIVE CONTROL: two functions sharing ONE name, one with a defaulted 3rd param, DO collide -- proves this spec detects the actual bug class", async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    await createLegacy3Arg(client!, LEGACY_NAME);
    await createNew2Arg(client!, LEGACY_NAME);

    const admin = adminClient() as unknown as SupabaseClient;
    const result = await callEventually(admin, LEGACY_NAME, { p_organization_id: 1, p_email: "x@example.com" }, { expectAmbiguous: true });
    expect(result.error?.code, JSON.stringify(result)).toBe("PGRST203");
  });

  test("STATE 1 (migrations 1-17, production baseline): the legacy 3-arg-with-default function alone resolves unambiguously for the app's real 2-arg call shape", async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    await createLegacy3Arg(client!, LEGACY_NAME);

    const admin = adminClient() as unknown as SupabaseClient;
    const result = await callEventually(admin, LEGACY_NAME, { p_organization_id: 1, p_email: "x@example.com" });
    expect(result.error, JSON.stringify(result.error)).toBeNull();
    expect(result.data).toBe("legacy");
  });

  test("STATE 2 (after prepare / --expand applied, before deploy): adding the NEW function under its OWN name leaves the old call unambiguous, and the new call also resolves -- old and new application code both work at once", async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    await createLegacy3Arg(client!, LEGACY_NAME);
    await createNew2Arg(client!, NEW_NAME);

    const admin = adminClient() as unknown as SupabaseClient;

    const oldCall = await callEventually(admin, LEGACY_NAME, { p_organization_id: 1, p_email: "x@example.com" });
    expect(oldCall.error, JSON.stringify(oldCall.error)).toBeNull();
    expect(oldCall.data).toBe("legacy");

    const newCall = await callEventually(admin, NEW_NAME, { p_organization_id: 1, p_email: "x@example.com" });
    expect(newCall.error, JSON.stringify(newCall.error)).toBeNull();
    expect(newCall.data).toBe("new");
  });

  test("STATE 3 (after finalize / --enforce applied): the legacy function is gone (PGRST202, not PGRST203), the new function is unaffected", async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    await createNew2Arg(client!, NEW_NAME);
    // Legacy deliberately never (re)created here -- mirrors finalize's
    // post-drop state (migrations 20260906090000/20260906100000).

    const admin = adminClient() as unknown as SupabaseClient;

    const oldCall = await callEventually(admin, LEGACY_NAME, { p_organization_id: 1, p_email: "x@example.com" }, { expectMissing: true });
    // Never PGRST203 (ambiguous -- the actual bug class this spec guards
    // against) and never a success -- accept either "not in PostgREST's
    // schema cache" (PGRST202) or Postgres's own raw "undefined function"
    // (42883, seen when a just-dropped function is called before the
    // cache itself has caught up) as valid evidence the function is gone.
    expect(oldCall.error, "expected an error calling a dropped function").not.toBeNull();
    expect(oldCall.error?.code, JSON.stringify(oldCall.error)).not.toBe("PGRST203");
    expect(["PGRST202", "42883"]).toContain(oldCall.error?.code);

    const newCall = await callEventually(admin, NEW_NAME, { p_organization_id: 1, p_email: "x@example.com" });
    expect(newCall.error, JSON.stringify(newCall.error)).toBeNull();
    expect(newCall.data).toBe("new");
  });
});
