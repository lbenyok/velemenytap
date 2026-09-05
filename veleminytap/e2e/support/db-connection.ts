import { Client } from "pg";
import { APPROVED_TEST_PROJECT_REF } from "./env";

/**
 * Round-5 finding R5-02: this used to run two regexes against the RAW
 * connection string with `.exec()` -- an unanchored search, not a parse.
 * `.exec()` finds its pattern ANYWHERE in the string, including the query
 * string, path, or password, none of which the server actually
 * authenticates against. A connection string that genuinely points at
 * production's pooler but happens to carry the approved test project's
 * ref somewhere else in the string (e.g.
 * `...@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?application_name=db.<approved-ref>.supabase.co`)
 * passed this check while actually connecting to production -- exactly
 * the outcome this allowlist exists to prevent.
 *
 * Fixed by actually parsing the URL and extracting the ref only from the
 * one component that's authoritative for each connection form: the
 * hostname for a direct connection, the username for a pooler connection
 * (the pooler host itself is shared across many projects/regions, so it
 * can't identify one on its own). The password, path, query string, and
 * fragment are never inspected -- a client fully controls all four, and
 * none of them is what the server actually authenticates the connection
 * against.
 */
export function projectRefFromDbUrl(dbUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(dbUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return null;
  }

  const hostname = url.hostname.toLowerCase();

  // Direct connection: db.<ref>.supabase.co -- the ref must be the
  // hostname's ENTIRE first label, matched against the whole hostname
  // (anchored), not found as a substring anywhere in the URL. This also
  // rejects a suffixed lookalike host (db.<ref>.supabase.co.evil.com).
  const directMatch = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(hostname);
  if (directMatch) {
    return directMatch[1];
  }

  // Pooler connection: aws-<n>-<region>.pooler.supabase.com, used instead
  // of the direct host wherever IPv6-only egress isn't available (CI
  // runners; see DEPLOYMENT.md). The ref lives in the username
  // ("postgres.<ref>"), decoded first since a URL's username component is
  // percent-encoded and an encoded ref must be treated the same as a
  // plain one, not silently fail to match.
  if (/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)) {
    const username = decodeURIComponent(url.username);
    const usernameMatch = /^postgres\.([a-z0-9]+)$/.exec(username);
    if (usernameMatch) {
      return usernameMatch[1];
    }
  }

  return null;
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
