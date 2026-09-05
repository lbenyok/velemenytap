# Architecture

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16, App Router, Turbopack, React 19, TypeScript strict |
| Styling / UI | Tailwind v4, shadcn/ui (`base-nova` preset, Base UI primitives — not Radix) |
| Database | Supabase Postgres |
| Auth | Supabase Auth via `@supabase/ssr`, cookie-based sessions, `getClaims()` for server-side identity |
| Authorization | Postgres Row Level Security (RLS) — the actual tenant boundary, not app code |
| Email | Resend (optional — degrades to a console warning if unconfigured) |
| Error monitoring | Sentry (`@sentry/nextjs`, optional — no-op if unconfigured), with a `beforeSend` redaction hook stripping feedback content — see `SECURITY.md` |
| Hosting | Vercel |

## Multi-tenant hierarchy

```
organization
  └─ location (1..n)
       └─ nfc_card (1..n)
            └─ feedback (0..n)

organization ─ organization_membership ─ auth.users
```

`organization_id` is denormalized onto `nfc_cards` and `feedback` (not derived only through joins) for RLS performance and simpler policies. Three trigger functions keep that denormalization honest — see `DATABASE_SCHEMA.md`.

## Request paths

**Dashboard (authenticated).** Server Components read through the request-scoped Supabase client (`lib/supabase/server.ts`), which carries the user's cookies, so every query is subject to RLS as that user. `getCurrentOrganization()` (`features/organizations/current.ts`) resolves which org a signed-in user is acting as (see `DECISIONS.md` for the single-org-per-user simplification). Mutations go through Server Actions (`features/*/actions.ts`), using the same RLS-bound client — with one exception: onboarding (`createOrganizationAction`) calls `create_organization_atomic`, a `SECURITY DEFINER` database function, through that same client — the client itself never switches to the admin client, but the function it calls runs with elevated privilege for the one operation (bootstrapping a brand-new user's first organization) that plain RLS structurally can't authorize. See `SECURITY.md` § "The deliberate RLS bypasses" for the full reasoning and mitigations.

**Public feedback submission (unauthenticated).** `app/r/[publicId]/page.tsx` reads card/location/org info through `lookupPublicCard` and renders the rating UI. Submission goes through `submitFeedbackAction` (`features/feedback/actions.ts`), a Server Action that:
1. Validates input with zod.
2. Checks a short-lived HttpOnly cookie to reject an accidental duplicate tap.
3. Calls `submit_feedback_atomic` (via the **admin client**, `lib/supabase/admin.ts`, secret key, `import "server-only"` guarded) — a single atomic database function that re-resolves the card server-side (never trusts client-supplied org/location/card ids), re-checks both the card and its location are still active, enforces a per-card rate limit, and inserts, all as one transaction with both the card and location rows locked for its duration. This replaced a separate lookup-then-insert that had a real TOCTOU race (a card deactivated in between the two requests would still accept the submission) and no rate limiting at all; a round-2 review (R2-05) found the first fix locked only the card row, not the location row it also reads status from, and closed that narrower race too.
4. Schedules the negative-feedback alert email via `next/server`'s `after()`, so a slow or failed email send can never affect the customer-facing response — the alert itself is now cooldown-limited per card (`SECURITY.md`) so a burst of qualifying submissions sends at most one email per window, not one per submission.

The admin client is not "the one deliberate RLS bypass" (an earlier version of this document said so) — see `SECURITY.md` § "The deliberate RLS bypasses" for the current, verified accounting of every place RLS is bypassed and why.

**Proxy / route protection.** `proxy.ts` (renamed from the default `middleware.ts`) is protect-by-default: everything except `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`, `/api/e2e-config-check`, `/api/notification-email/confirm`, `/api/health`) requires a session, redirecting to `/login` otherwise. `/api/notification-email/confirm` (round-3 R3-03) is a confirmation-link target clicked from an email, possibly with no session at all; `/api/health` (round-4 R4-01) is polled by CI and `scripts/rollout.mjs`, neither of which has one either.

## Directory layout

```
app/                  routes (App Router)
  dashboard/           authenticated dashboard pages
  r/[publicId]/        public NFC landing page
  login/ signup/ auth/  auth flow
features/             feature-oriented domain code
  auth/ organizations/ locations/ nfc-cards/ feedback/ analytics/ notifications/
  each typically: actions.ts (Server Actions), *-form.tsx, *-table.tsx, page-level components
lib/supabase/          server.ts (RLS-bound client), admin.ts (secret-key client), database.types.ts (hand-written)
lib/build-info.ts       auto-generated at build time (scripts/generate-build-info.mjs) -- do not edit
supabase/migrations/    imperative SQL migrations, applied in order
scripts/                operator tooling, not application code: generate-build-info.mjs (build-time),
                        rollout.mjs (round-4 R4-03 -- see DEPLOYMENT.md)
```

`features/` is organized by domain, not by technical layer, per the product skill's suggested structure. Do not reorganize without a clear reason.

`e2e/` — Playwright browser tests, outside `app`/`features`/`lib` since they're not application code. `.github/workflows/ci.yml` lives at the **repo root** (one level above `veleminytap/`), since that's where `.git` actually is — GitHub only reads workflow files from the repo root's `.github/workflows/`, so it couldn't live inside `veleminytap/` even if that were otherwise preferred (see `DECISIONS.md`'s note on doc placement for the same repo-root-vs-`veleminytap/` distinction).

## Deployment verification (round-4 R4-01)

For an extended period spanning three review rounds, `master` had reviewed, merged, migration-backed fixes that were never actually live in production — Vercel's Git integration had silently stopped creating deployments, and nothing in this repository checked. `app/api/health/route.ts` plus `.github/workflows/ci.yml`'s `verify-production-deployment` job exist specifically to make that failure mode loud instead of silent:

- `/api/health` reports Vercel's own System Environment Variables (`VERCEL_GIT_COMMIT_SHA`, `VERCEL_ENV`) plus a build-time snapshot of which migration this specific build expects (`lib/build-info.ts`, generated by `scripts/generate-build-info.mjs`, wired into `predev`/`prebuild`) — no secrets, no database connection.
- It returns HTTP 503 (`ok: false`) if `VERCEL_ENV` indicates production/preview but no commit SHA is present, rather than reporting success with a null value — this is the one thing a self-report *can* catch on its own (a misconfigured "expose System Environment Variables" project setting), as opposed to a dead Git webhook, which looks identical to a healthy, simply-not-yet-redeployed app from the endpoint's own point of view.
- CI's `verify-production-deployment` job is the independent check that actually catches a dead webhook: it polls the live endpoint after every push to `master` until it reports the pushed commit, and fails loudly if that never happens within 5 minutes.

See `DEPLOYMENT.md` for the full runbook, including what Vercel/GitHub configuration this repository's own code cannot enforce (the Git connection itself, Root Directory, branch protection, deployment promotion gating).

## Key technical decisions

- **Cursor-based pagination** on a compound `(created_at, id)` key, not `OFFSET` and not `created_at` alone — stable under concurrent inserts, and specifically under rows sharing an identical `created_at` (a real scenario, not just theoretical: a submission burst up to the rate limit, or simply several customers tapping the same busy location within the same instant). `created_at` alone ties in exactly that case, and a page boundary landing inside a tied group could silently skip whichever row wasn't on the earlier page — `id`, a strictly increasing identity column, is what makes the ordering a true total order.
- **Analytics computed entirely in SQL**, not fetched into Node — `get_feedback_overview_snapshot`/`get_feedback_period_analytics` (`DATABASE_SCHEMA.md`) compute every statistic inside one tenant-scoped function call per page, superseding round 1's page-by-page row fetching once a round-2 review (R2-02/R2-03) confirmed that approach still had both a silent row-count ceiling and `OFFSET`-pagination inconsistency under concurrent writes — see `DECISIONS.md` for why round 1 chose page-fetching first and what changed.
- **`database.types.ts` is hand-written**, not generated via `supabase gen types` (no local Docker environment available), and is updated by hand alongside every migration.
- **Base UI, not Radix**, per the installed shadcn preset — component APIs (`render` prop instead of `asChild`, etc.) differ accordingly.
- **`priority` is a Postgres generated column** (`feedback.priority`, derived from `rating`), not computed in application code, so it can never drift from the rating that produced it.
- **Column-protecting triggers ship as two migrations, not one, when the column already has a production consumer.** The alert-cooldown and notification-email-change triggers (round 3, R3-05) are each split into an "expand" migration (new columns/functions, no enforcement yet) and a later "enforce" migration (the trigger itself) — applying both together would break currently-deployed application code that still writes the protected column(s) directly, in the gap between the migration landing and new code deploying. See `DATABASE_SCHEMA.md` § "Rollout ordering."

## What's deliberately not built (see `DECISIONS.md` for the reasoning behind each)

- Redis/IP-based rate limiting on the public submission endpoint — a database-backed rate limit (`submit_feedback_atomic`, 20 submissions per card per 5 minutes) is built and enforced; Redis specifically was evaluated and skipped as unnecessary infrastructure once the same limit could be enforced inside the existing atomic database function, per the product skill's "avoid unnecessary infrastructure."
- An organization switcher (schema supports multi-org membership; UI always resolves the earliest-joined org).
- Role-gated dashboard authorization (owner/admin/manager/staff exist in the schema; no invite flow exists yet, so only "owner" is ever actually assigned).
- File-upload UI for the organization logo (a pasted URL field instead).
- ~~Verified `notification_email` recipients for negative-feedback alerts.~~ **Done in round 3** (R3-03) — a real confirmation-link flow, not just the org-wide budget mitigation this line originally described. See `SECURITY.md` § "Notification recipient verification" and `DECISIONS.md` § "R2-08."
