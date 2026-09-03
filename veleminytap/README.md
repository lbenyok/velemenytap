# VéleményTap

NFC-based customer feedback and reputation management for physical businesses. A customer taps an NFC card, rates their visit 1–5 stars, optionally leaves a comment, and is offered a Google Review link — regardless of the rating they gave. The business sees every submission in a dashboard, gets emailed about negative feedback, and can track trends over time.

See also: [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) (what it does and why), [ARCHITECTURE.md](./ARCHITECTURE.md) (how it's built), [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) (tables, RLS), [SECURITY.md](./SECURITY.md), [DECISIONS.md](./DECISIONS.md), [TEST_PLAN.md](./TEST_PLAN.md), [STATUS.md](./STATUS.md).

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · React 19 · Tailwind v4 · shadcn/ui (Base UI primitives) · Supabase (Postgres, Auth, RLS) · Resend · Vercel.

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

## Scripts

```bash
npm run dev         # start the dev server (Turbopack)
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
```

## Database migrations

Imperative migrations under `supabase/migrations/`. To apply locally against the linked project:

```bash
supabase db push --db-url "$SUPABASE_DB_URL"
```

Never hand-edit the production schema outside a migration file — see the Database Change Workflow in `DATABASE_SCHEMA.md`.

## Deployment

Hosted on Vercel (`veleminytap` project), deployed from the `main` branch. Production: https://veleminytap.vercel.app.

```bash
vercel deploy --prod
```
