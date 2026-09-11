/**
 * Test-configuration verification only (round-2 finding R2-06) -- not a
 * general-purpose diagnostics endpoint. Playwright's global setup
 * (e2e/support/verify-server-config.ts) fetches this before any test runs
 * to confirm the actual running server is configured against the same
 * Supabase project the test fixtures use, so a stray `npm run dev` left
 * running from another terminal (pointed at whatever `.env.local` happens
 * to say, which could be production) can never be silently reused as the
 * server under test.
 *
 * Returns only NEXT_PUBLIC_SUPABASE_URL, which is already public: it is
 * inlined into the client-side JS bundle by Next.js's own build process
 * (that's what the NEXT_PUBLIC_ prefix means), so this route discloses
 * nothing that isn't already visible to anyone opening browser dev tools.
 */
export async function GET() {
  return Response.json({ supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null });
}
