import { Client } from "pg";
import { APPROVED_TEST_PROJECT_REF } from "./env";

function projectRefFromDbUrl(dbUrl: string): string | null {
  // postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres (or
  // the pooler host, ...pooler.supabase.com) -- either way the project ref
  // is the first label of the hostname after "db." or the "aws-..." pooler
  // segment's tenant identifier. Only the direct-connection form is used
  // by this project (see e2e/README.md), so match that specifically.
  const match = /db\.([a-z0-9]+)\.supabase\.co/.exec(dbUrl);
  return match ? match[1] : null;
}

function inCi(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

/**
 * Round-4 finding R4-04. SUPABASE_DB_URL is optional for LOCAL runs --
 * not every contributor has, or needs, a direct Postgres connection; the
 * rest of the suite works fine over HTTPS/PostgREST. In CI it is not
 * optional: a missing, invalid, unreachable, or wrong-project value must
 * fail the run loudly, never silently skip the two spec files that need a
 * raw connection (the RPC privilege matrix, R3-07; the location-
 * deactivation concurrency test, R2-05) -- a security-relevant privilege
 * matrix or a concurrency guarantee reporting green because it never
 * actually ran is false confidence, not "missing coverage that degrades
 * gracefully." This project has already been burned once by an
 * unverified assumption about what was actually running where (the
 * Vercel deployment gap, STATUS.md) -- this closes the equivalent gap
 * for test coverage itself.
 *
 * The project-ref check (reusing e2e/support/env.ts's same allowlist)
 * applies unconditionally, not just in CI: a developer who accidentally
 * points SUPABASE_DB_URL at production must be refused locally too, not
 * only caught by CI.
 *
 * Returns `null` only for the "optional and genuinely absent, locally"
 * case -- every other failure mode throws.
 */
export async function connectToTestDb(): Promise<Client | null> {
  const dbUrl = process.env.SUPABASE_DB_URL;

  if (!dbUrl) {
    if (inCi()) {
      throw new Error(
        "SUPABASE_DB_URL is required in CI (round-4 R4-04) but is not set. Add it as a " +
          "GitHub Actions repository secret (Settings -> Secrets and variables -> Actions), " +
          "pointed at the isolated test project's direct Postgres connection string -- never " +
          "production's. Locally this is optional and these tests skip gracefully without it; " +
          "in CI it must never be silently skipped.",
      );
    }
    return null;
  }

  const projectRef = projectRefFromDbUrl(dbUrl);
  if (projectRef !== APPROVED_TEST_PROJECT_REF) {
    throw new Error(
      `SUPABASE_DB_URL does not resolve to the approved isolated test project (expected ` +
        `project ref "${APPROVED_TEST_PROJECT_REF}", got "${projectRef ?? "unparseable"}"). ` +
        "Refusing to connect -- this is very likely production or an unrecognized project.",
    );
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (inCi()) {
      throw new Error(`SUPABASE_DB_URL is set in CI but the connection failed: ${message}`);
    }
    return null;
  }
}
