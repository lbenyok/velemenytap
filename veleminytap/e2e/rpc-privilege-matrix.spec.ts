import { test, expect } from "@playwright/test";
import { Client } from "pg";

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
 * PostgREST/supabase-js. Skips gracefully, not a hard failure, if that
 * connection isn't available in this environment (same as
 * e2e/location-deactivation-race.spec.ts).
 */

const DB_URL = process.env.SUPABASE_DB_URL;

async function tryConnect(): Promise<Client | null> {
  if (!DB_URL) return null;
  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

type ExpectedGrant = {
  signature: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
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
];

let client: Client | null;

test.beforeAll(async () => {
  client = await tryConnect();
});

test.afterAll(async () => {
  await client?.end();
});

for (const expected of EXPECTED) {
  test(`R3-07: ${expected.signature} grants exactly the intended role matrix`, async () => {
    test.skip(!client, "No direct Postgres connection available in this environment.");
    if (!client) return;

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
