# VéleményTap

NFC-based customer feedback and reputation management for physical businesses. A customer taps an NFC card, rates their visit 1–5 stars, optionally leaves a comment, and is offered a Google Review link — regardless of the rating they gave. The business sees every submission in a dashboard, gets emailed about negative feedback, and can track trends over time.

See also: [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) (what it does and why), [ARCHITECTURE.md](./ARCHITECTURE.md) (how it's built), [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) (tables, RLS), [SECURITY.md](./SECURITY.md), [DECISIONS.md](./DECISIONS.md), [TEST_PLAN.md](./TEST_PLAN.md), [STATUS.md](./STATUS.md), [DEPLOYMENT.md](./DEPLOYMENT.md) (how a commit actually gets to production), [e2e/README.md](./e2e/README.md).

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · React 19 · Tailwind v4 · shadcn/ui (Base UI primitives) · Supabase (Postgres, Auth, RLS) · Resend · Sentry · Vercel.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Resend values
npm run dev
```

Required env vars (see `.env.example`):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — client-safe Supabase config.
- `SUPABASE_SECRET_KEY` — server-only, never exposed to the browser. Used for privileged writes (public feedback inserts, membership bootstrap, notification email lookups).
- `SUPABASE_DB_URL` — used locally to push migrations (`supabase db push --db-url`). Never commit.
- `NEXT_PUBLIC_SITE_URL` — the deployed origin, used to build links in emails.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — optional. Negative-feedback alert emails are skipped (with a console warning) if unset, so the app runs fully without a Resend account.
- `NEXT_PUBLIC_SENTRY_DSN` — optional. Error monitoring across client/server/edge; `Sentry.init()` with no DSN is a documented no-op, so the app runs fine without one. Public by design (see `SECURITY.md`), not a secret.

## Scripts

```bash
npm run dev         # start the dev server (Turbopack)
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
npm run test          # Vitest (pure logic only)
npm run test:e2e      # Playwright — see e2e/README.md before running
```

## Database migrations

Imperative migrations under `supabase/migrations/`. To apply locally against the linked project:

```bash
supabase db push --db-url "$SUPABASE_DB_URL"
```

Never hand-edit the production schema outside a migration file — see the Database Change Workflow in `DATABASE_SCHEMA.md`.

## CI

`.github/workflows/ci.yml` (at the repo root, one level above this directory — see `ARCHITECTURE.md`) runs typecheck/lint/Vitest on every push and PR to `master`. Playwright e2e also runs there if the repo has all four required Actions secrets configured (`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY`/`SUPABASE_DB_URL` — the last became mandatory in round 4, R4-04) — skips gracefully otherwise. A separate job then confirms production actually deployed the pushed commit (round-4 R4-01). See `e2e/README.md` and `DEPLOYMENT.md` §§ 4–5.

## Deployment

Hosted on Vercel (`veleminytap` project, Root Directory `veleminytap`), auto-deployed from pushes to `master` via Vercel's GitHub integration — **not** run by hand from a local `vercel` CLI invocation, which would deploy whatever's on disk rather than what CI has actually verified. Production: https://veleminytap.vercel.app.

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full runbook: required Vercel/GitHub configuration (round-4 finding R4-02 — a real Git-integration failure once left production silently running months-old code, see `STATUS.md`), environment variable scopes, the CI gating model, `/api/health` version verification, and the expand/deploy/enforce rollout procedure (`scripts/rollout.mjs`) for migrations that need it.
