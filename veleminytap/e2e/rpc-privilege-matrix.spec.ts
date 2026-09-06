import { test, expect } from "@playwright/test";
import type { Client } from "pg";
import { connectToTestDb } from "./support/db-connection";

/**
 * Round-3 finding R3-07: the RPC role-allowlist model (round-2 R2-07,
 * plus this round's own get_feedback_overview_snapshot gap) was verified
 * by hand during development -- has_function_privilege() and pg_proc.proacl
 * inspected manually -- but never committed as an automated test. This is
 * that test, run against the real isolated project's actual catalogs, not
 * a re-statement of what the migration files say should be true.
 *
 * Needs a direct Postgres connection (SUPABASE_DB_URL) -- has_function_privilege()
 * and pg_proc are Postgres catalog features, not reachable through
 * PostgREST/supabase-js. Skips gracefully LOCALLY if that connection isn't
 * available; round-4 finding R4-04 makes this mandatory in CI instead --
 * see e2e/support/db-connection.ts.
 */

type ExpectedGrant = {
  signature: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  // Round-6 R6-01/R6-03: the round-3 3-argument request_notification_email_change
  // is a real production object (migration 20260904194400) that a later
  // corrective migration (20260906090000) strips every grant from, kept
  // defined only until a future cleanup migration drops it. This isolated
  // test project's own migration history does not necessarily retain
  // every historical production object in the exact same shape (its
  // history is built up independently -- see DECISIONS.md/STATUS.md) --
  // this flag lets both tests below tolerate the function's absence here
  // without silently tolerating the absence of anything else.
  mayNotExistInThisEnvironment?: boolean;
};

const EXPECTED: ExpectedGrant[] = [
  {
    signature: "public.submit_feedback_atomic(uuid, smallint, text)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  {
    signature: "public.create_organization_atomic(text)",
    anon: false,
    authenticated: true,
    service_role: false,
  },
  {
    signature: "public.get_feedback_overview_snapshot(bigint)",
    anon: false,
    authenticated: true,
    service_role: false,
  },
  {
    signature: "public.get_feedback_period_analytics(bigint, int)",
    anon: false,
    authenticated: true,
    service_role: false,
  },
  {
    signature: "public.claim_negative_alert_send(bigint, int, int)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  {
    signature: "public.finalize_negative_alert_send(bigint, boolean)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  // Round-5 finding R5-10: these were never added to this matrix despite
  // DATABASE_SCHEMA.md/SECURITY.md documenting them all as covered by it --
  // the catalog itself was never independently re-checked against that
  // claim until now.
  {
    // Round-6 R6-01/R6-04: no longer returns the token or accepts caller-
    // suppliable cooldown/budget parameters -- see
    // supabase/migrations/20260905193325_....sql.
    signature: "public.request_notification_email_change(bigint, text)",
    anon: false,
    authenticated: true,
    service_role: false,
  },
  {
    // Round-6 R6-01: the only function that ever sees the plaintext
    // confirmation token -- service_role only, never authenticated, so no
    // browser or ordinary authenticated Supabase client can obtain one.
    signature: "public.issue_notification_email_change_token(bigint, int)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  {
    // Round-6 R6-04: was authenticated (a client could report its own
    // reservation delivered/failed) -- now service_role only.
    signature: "public.finalize_notification_email_change_send(bigint, boolean)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  {
    signature: "public.clear_notification_email(bigint)",
    anon: false,
    authenticated: true,
    service_role: false,
  },
  {
    signature: "public.confirm_notification_email_change(text)",
    anon: false,
    authenticated: false,
    service_role: true,
  },
  {
    // Round-3's original 3-argument version, still deployed to production
    // and deliberately left in place (round-6 R6-03) -- but round-6 R6-01
    // found it returns the plaintext token directly to `authenticated`,
    // the same live vulnerability the 2-argument replacement above exists
    // to fix. Migration 20260906090000 revokes `authenticated`'s grant
    // immediately (not a rollout-compatibility exception for a function
    // that IS the vulnerability) -- so it now has zero grants to any
    // client-reachable role, kept only until a future cleanup migration
    // drops it outright once nothing could still be calling it.
    signature: "public.request_notification_email_change(bigint, text, int)",
    anon: false,
    authenticated: false,
    service_role: false,
    mayNotExistInThisEnvironment: true,
  },
];

let client: Client | null;

test.beforeAll(async () => {
  client = await connectToTestDb();
});

test.afterAll(async () => {
  await client?.end();
});

for (const expected of EXPECTED) {
  test(`R3-07: ${expected.signature} grants exactly the intended role matrix`, async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    if (!client) return;

    if (expected.mayNotExistInThisEnvironment) {
      const { rows: existsRows } = await client.query("select to_regprocedure($1) is not null as exists", [
        expected.signature,
      ]);
      test.skip(
        !existsRows[0].exists,
        `${expected.signature} does not exist in this environment's catalog -- expected to be absent in some (see the EXPECTED entry's comment).`,
      );
      if (!existsRows[0].exists) return;
    }

    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const { rows } = await client.query(
        "select has_function_privilege($1, $2, 'EXECUTE') as has_priv",
        [role, expected.signature],
      );
      expect(
        rows[0].has_priv,
        `${role} EXECUTE on ${expected.signature} should be ${expected[role]}`,
      ).toBe(expected[role]);
    }

    // Direct ACL inspection, not just has_function_privilege()'s effective
    // (role-inheriting) view -- confirms there's no lingering PUBLIC grant
    // either, which is exactly the class of gap round-2 finding R2-07
    // found (a `revoke ... from public` that didn't actually do anything,
    // because ALTER DEFAULT PRIVILEGES had already granted the real roles
    // their own independent ACL entries regardless of PUBLIC).
    const { rows } = await client.query(
      "select proacl::text as acl from pg_proc where oid = $1::regprocedure",
      [expected.signature],
    );
    const acl = String(rows[0]?.acl ?? "");
    // An aclitem for PUBLIC has an empty grantee before "=", e.g. "=X/owner".
    expect(acl, `${expected.signature}'s ACL must not contain a PUBLIC grant`).not.toMatch(/(^|,)=[a-zA-Z]*X/);
  });
}

/**
 * Round-5 finding R5-10: the per-function tests above only prove the
 * EXPECTED list itself is correct -- they say nothing about whether
 * EXPECTED is still the complete list. This is exactly how three real
 * functions (the notification-email confirmation flow) went unchecked
 * for two rounds despite DATABASE_SCHEMA.md/SECURITY.md both claiming
 * "every function checked automatically." Comparing against the actual
 * catalog means a new RPC added later without a matching EXPECTED entry
 * fails this test immediately, rather than silently having zero
 * privilege coverage.
 */
test("EXPECTED accounts for every function in the public schema, not just the ones someone remembered to list", async () => {
  test.skip(!client, "No direct Postgres connection available in this environment.");
  if (!client) return;

  const { rows } = await client.query(`
    select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
    order by 1
  `);
  // Normalize away formatting differences that don't reflect a real
  // mismatch: pg_get_function_identity_arguments() returns "p_name type"
  // pairs (parameter names included) while this file, matching
  // DATABASE_SCHEMA.md's own convention, lists bare types only; Postgres
  // also spells a type "integer" where this file says "int". Comparing on
  // substance (function name + ordered type list), not incidental string
  // shape.
  const normalize = (s: string) => {
    const match = /^(.*?)\((.*)\)$/.exec(s.trim());
    if (!match) return s;
    const [, name, argsInner] = match;
    const types = argsInner
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+/).pop()!.replace(/integer/g, "int"));
    return `${name}(${types.join(",")})`;
  };
  const actual = new Set(rows.map((r) => normalize(r.signature as string)));
  // Entries flagged mayNotExistInThisEnvironment are excluded from the
  // "expected" side when the live catalog doesn't actually have them --
  // this test's purpose is catching an UNEXPECTED function nothing
  // accounts for, not requiring every hypothetically-possible one to be
  // present in every environment (see the flag's own comment above).
  const expected = EXPECTED.filter((e) => !e.mayNotExistInThisEnvironment || actual.has(normalize(e.signature))).map(
    (e) => normalize(e.signature),
  );
  expect([...actual].sort(), "a function exists in public that EXPECTED above doesn't cover").toEqual(
    expected.sort(),
  );
});
