# e2e tests

Playwright, against a real running app and a real Supabase project — a **dedicated, isolated project**, not the one used for local dev/production (see `DECISIONS.md` for why there's no Docker-based local stack instead).

## Running locally

Needs `.env.test.local` filled in at the repo root (gitignored, never committed) with an isolated Supabase project's credentials:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

`e2e/support/env.ts` loads this file directly (Playwright test files run under plain Node, not through Next's own env loading). Credentials are resolved from **exactly one** canonical source — a fully-populated `.env.test.local`, or a fully-populated process environment (CI's case) — never a mix of the two; a source that's only partially complete is rejected rather than silently topped up from the other (round-3 finding R3-01). Once resolved, the three required keys are validated against an explicit allowlisted project reference and then written into `process.env`, overwriting anything already there — so this process's own fixtures (`e2e/support/seed.ts`) and the spawned `next dev`/`next start` process (`playwright.config.ts`'s `webServer.env`, built from the same resolved object) are guaranteed to agree, not just independently "probably fine." **There is no fallback to `.env.local` at all** — if neither source is complete, or the resolved project isn't the approved one, this throws immediately rather than running anything against production.

New migrations need to be applied to the isolated project by hand (there's no CI-driven migration step yet): `npx supabase db push --db-url "<the isolated project's direct Postgres connection string>"`.

Optionally export `SUPABASE_DB_URL` (same connection string) in your shell before running the suite — `.env.test.local` alone does **not** put it into `process.env` (it's not one of `env.ts`'s required keys, deliberately, since most of the suite doesn't need it). Without it, `rpc-privilege-matrix.spec.ts` and `location-deactivation-race.spec.ts` silently skip every test rather than failing, which is easy to mistake for a clean pass — check the run's own output for `skipped` counts, not just "no failures."

```bash
npx playwright install --with-deps chromium   # one-time
npm run test:e2e
```

Also make sure nothing else is already listening on port 3000 before running the suite — Playwright reuses an existing server there (`reuseExistingServer`) rather than starting its own, and a stray `npm run dev` from another terminal would be running against `.env.local` (production), silently defeating the isolation above.

```bash
npx playwright install --with-deps chromium   # one-time
npm run test:e2e
```

Playwright starts `npm run dev` itself (`playwright.config.ts`'s `webServer`) and waits for `http://localhost:3000` to respond — no separate terminal needed. Test data (throwaway orgs/locations/cards/auth users, prefixed `E2E ...`) is created before each suite/test and deleted after, in `e2e/support/seed.ts`. If a run is killed mid-suite, cleanup may not fire — check the isolated project for leftover `organizations` rows or auth users and delete them by hand if that happens. Since this is a dedicated test project, this is inconvenient but never destructive to real data.

## What's covered

`review-gating.spec.ts` — the product skill's Review-Gating Regression Test, automated: for each rating 1–5, load the public feedback page, submit that rating, and assert the "Leave a Google review" CTA is visible with the correct `href`. Plus one test confirming a duplicate submission on the same card (same browser context) is rejected rather than silently creating a second row.

`redirect-safety.spec.ts` — drives the real login and email-confirmation flows against the open-redirect fix (`lib/safe-redirect.ts`): a backslash-variant `next` param (`/\evil.example.com`, which a real browser's URL parser resolves the same as `//evil.example.com`) must never navigate away from the site, through either call site, plus round-2's dot-segment/double-slash-pathname payloads (R2-01).

`billing-paywall.spec.ts` — the subscription paywall (`app/dashboard/layout.tsx`): a freshly signed-up org (still inside its trial) can reach the dashboard; an org with no active subscription is redirected to `/dashboard/billing` from any dashboard route, not just the initial landing page; the billing page itself never redirects even when inactive (no redirect loop); and — the invariant that matters most — public feedback submission through `/r/{publicId}` keeps working, unauthenticated, even for an organization whose subscription is inactive. Same shape as `review-gating.spec.ts`'s non-negotiable-invariant test.

16 spec files total, each named for the finding(s) it covers and carrying its own doc comment explaining what it verifies and why — `tenant-isolation`, `analytics-aggregation`, `analytics-period-validation`, `location-deactivation-race`, `rpc-privilege-matrix`, `negative-feedback-alert-abuse`, `negative-feedback-alert-finalize`, `notification-email-verification`, `nfc-card-location-lock`, `organization-onboarding`, `public-submission-safety`, `feedback-and-card-integrity`, `feedback-pagination`, `billing-paywall` among them. `rpc-privilege-matrix.spec.ts` and `location-deactivation-race.spec.ts` need a direct Postgres connection (`SUPABASE_DB_URL`, below) and skip gracefully, not fail, without one — **a skipped run of either is not equivalent to a passing one**; confirm they actually executed before treating a green suite as complete evidence.

## CI

`.github/workflows/ci.yml` (at the repo root, one level up from this file) runs `typecheck`/`lint`/`npm run test` (Vitest) on every push/PR unconditionally. The `e2e` job additionally needs these repository secrets to run at all — **add them under GitHub repo Settings → Secrets and variables → Actions**, pointed at the **isolated test project**, not production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

(Same values as `.env.test.local`, above — **not** `.env.local`.) Without them, the `e2e` job's `check-e2e-secrets` step reports `configured: false` and the job is skipped — not failed — so CI stays green on the parts that can run. If these secrets were ever set from `.env.local`, update them to the isolated project's values — `e2e/support/env.ts` now actively rejects a resolved project that isn't the one it allowlists, so a production value here fails loudly (`loadEnvVars` throws) rather than silently running the suite against production.

Optionally, add `SUPABASE_DB_URL` (the isolated project's direct/pooler Postgres connection string) as a repo secret too — `e2e/location-deactivation-race.spec.ts` needs a real second Postgres connection to interleave two transactions (not expressible through PostgREST/supabase-js) and skips itself, not fails, if this isn't set. Without it, that test's concurrency guarantee (round-2 R2-05) is never actually exercised in CI.
