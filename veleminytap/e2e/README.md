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

`e2e/support/env.ts` loads this file directly (Playwright test files run under plain Node, not through Next's own env loading) and prefers it over `.env.local` when present. `playwright.config.ts` also injects these same values into the spawned `next dev`/`next start` process's environment, so the actual server under test talks to the isolated project too — Next never overrides an env var that's already set in the process, so this takes priority over whatever `.env.local` (production) would otherwise supply. If `.env.test.local` doesn't exist, both fall back to `.env.local` — **don't run this suite without `.env.test.local`** unless you mean to test against production.

New migrations need to be applied to the isolated project by hand (there's no CI-driven migration step yet): `npx supabase db push --db-url "<the isolated project's direct Postgres connection string>"`.

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

`redirect-safety.spec.ts` — drives the real login and email-confirmation flows against the open-redirect fix (`lib/safe-redirect.ts`): a backslash-variant `next` param (`/\evil.example.com`, which a real browser's URL parser resolves the same as `//evil.example.com`) must never navigate away from the site, through either call site.

## CI

`.github/workflows/ci.yml` (at the repo root, one level up from this file) runs `typecheck`/`lint`/`npm run test` (Vitest) on every push/PR unconditionally. The `e2e` job additionally needs these repository secrets to run at all — **add them under GitHub repo Settings → Secrets and variables → Actions**, pointed at the **isolated test project**, not production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

(Same values as `.env.test.local`, above — **not** `.env.local`.) Without them, the `e2e` job's `check-e2e-secrets` step reports `configured: false` and the job is skipped — not failed — so CI stays green on the parts that can run. If these secrets were set from `.env.local` before this change, update them to the isolated project's values, or CI's e2e job runs against production.
