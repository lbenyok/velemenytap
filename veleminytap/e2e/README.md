# e2e tests

Playwright, against a real running app and a real Supabase project (the same one used for local dev — see `DECISIONS.md` for why there's no separate Docker-based local stack).

## Running locally

Needs `.env.local` filled in (same file `npm run dev` uses — `e2e/support/env.ts` loads it directly, since Playwright test files run under plain Node, not through Next's own env loading).

```bash
npx playwright install --with-deps chromium   # one-time
npm run test:e2e
```

Playwright starts `npm run dev` itself (`playwright.config.ts`'s `webServer`) and waits for `http://localhost:3000` to respond — no separate terminal needed. Test data (an org named `E2E Review Gating {timestamp}`, one location, five NFC cards) is created before the suite and deleted after, in `e2e/support/seed.ts`. If a run is killed mid-suite, its `afterAll` may not fire — check for and manually delete any `organizations` row named `E2E Review Gating %` if that happens.

## What's covered

`review-gating.spec.ts` — the product skill's Review-Gating Regression Test, automated: for each rating 1–5, load the public feedback page, submit that rating, and assert the "Leave a Google review" CTA is visible with the correct `href`. Plus one test confirming a duplicate submission on the same card (same browser context) is rejected rather than silently creating a second row.

## CI

`.github/workflows/ci.yml` (at the repo root, one level up from this file) runs `typecheck`/`lint`/`npm run test` (Vitest) on every push/PR unconditionally. The `e2e` job additionally needs these repository secrets to run at all — **add them under GitHub repo Settings → Secrets and variables → Actions**:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

(Same values as `.env.local`.) Without them, the `e2e` job's `check-e2e-secrets` step reports `configured: false` and the job is skipped — not failed — so CI stays green on the parts that can run.
