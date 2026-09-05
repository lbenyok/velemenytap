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
| Billing | Stripe (Checkout + Billing Portal, both Stripe-hosted — this app never handles card data itself) |
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

**Billing (subscription paywall).** Every organization gets a 14-day, no-card trial the instant it's created (`private.provision_organization_trial()`, `DATABASE_SCHEMA.md`). `app/dashboard/layout.tsx` gates every dashboard route except `/dashboard/billing` itself behind `isBillingActive()` (`features/billing/status.ts`) — protect-by-default, the same philosophy as `proxy.ts`'s auth gate, so a newly added dashboard page is covered automatically rather than needing an opt-in check. This deliberately does **not** touch the public NFC/feedback pages at all — a card already sold and sitting on a customer's counter keeps collecting real feedback regardless of its organization's billing status (see `PRODUCT_SPEC.md` and `DECISIONS.md`). The layout needs to know the *current* pathname (to exempt the billing page from its own redirect, avoiding a loop) — Server Components have no built-in way to read that, so `proxy.ts` forwards it as an `x-pathname` request header (Next.js's own documented recipe for this), read back via `next/headers`.

`signInAction` (`features/auth/actions.ts`) also calls `isBillingActive()` directly, resolving the post-login destination in one hop rather than redirecting to `/dashboard` and letting the layout redirect a second time. Two server-side `redirect()`s chained through one Server Action response is a real, reproducible bug under Turbopack dev-mode streaming (found and fixed while building this feature — the client's RSC-payload fetch for the second hop fails with a connection reset and falls back into a reload loop that never resolves). The layout's check is still the actual enforcement boundary for every other dashboard entry point; `signInAction`'s copy exists only to avoid the chain for this one path, not to relocate the security decision.

Subscribing/managing billing goes through Stripe Checkout and the Billing Portal, both Stripe-hosted pages this app only ever redirects to (`features/billing/actions.ts`'s `createCheckoutSessionAction`/`createPortalSessionAction`, Server Actions using the admin client — `organization_billing` has no `authenticated` write policy at all, see `DATABASE_SCHEMA.md`). `app/api/webhooks/stripe/route.ts` is the one place Stripe's state flows back in: signature-verified (`stripe.webhooks.constructEvent`), idempotent via `stripe_webhook_events` (Stripe documents at-least-once, possibly-duplicate delivery), and public in `proxy.ts`'s `PUBLIC_PATHS` since Stripe's servers call it with no session — the signature check is the real security boundary there, not the auth gate.

**Proxy / route protection.** `proxy.ts` (renamed from the default `middleware.ts`) is protect-by-default: everything except `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`, `/api/e2e-config-check`, `/api/notification-email/confirm`, `/api/webhooks/stripe`) requires a session, redirecting to `/login` otherwise. `/api/notification-email/confirm` (round-3 R3-03) is a confirmation-link target clicked from an email, possibly with no session at all; `/api/webhooks/stripe` is Stripe's own server calling in, never a browser with a session.

## Directory layout

```
app/                  routes (App Router)
  dashboard/           authenticated dashboard pages (billing/ is the one paywall-exempt page)
  api/webhooks/stripe/ Stripe webhook endpoint -- public, signature-verified
  r/[publicId]/        public NFC landing page
  login/ signup/ auth/  auth flow
features/             feature-oriented domain code
  auth/ organizations/ locations/ nfc-cards/ feedback/ analytics/ notifications/ billing/
  each typically: actions.ts (Server Actions), *-form.tsx, *-table.tsx, page-level components
  billing/ specifically: actions.ts (checkout/portal), queries.ts, status.ts (isBillingActive)
lib/supabase/          server.ts (RLS-bound client), admin.ts (secret-key client), database.types.ts (hand-written)
lib/stripe.ts           server-only Stripe client
supabase/migrations/    imperative SQL migrations, applied in order
```

`features/` is organized by domain, not by technical layer, per the product skill's suggested structure. Do not reorganize without a clear reason.

`e2e/` — Playwright browser tests, outside `app`/`features`/`lib` since they're not application code. `.github/workflows/ci.yml` lives at the **repo root** (one level above `veleminytap/`), since that's where `.git` actually is — GitHub only reads workflow files from the repo root's `.github/workflows/`, so it couldn't live inside `veleminytap/` even if that were otherwise preferred (see `DECISIONS.md`'s note on doc placement for the same repo-root-vs-`veleminytap/` distinction).

## Key technical decisions

- **Cursor-based pagination** on a compound `(created_at, id)` key, not `OFFSET` and not `created_at` alone — stable under concurrent inserts, and specifically under rows sharing an identical `created_at` (a real scenario, not just theoretical: a submission burst up to the rate limit, or simply several customers tapping the same busy location within the same instant). `created_at` alone ties in exactly that case, and a page boundary landing inside a tied group could silently skip whichever row wasn't on the earlier page — `id`, a strictly increasing identity column, is what makes the ordering a true total order.
- **Analytics computed entirely in SQL**, not fetched into Node — `get_feedback_overview_snapshot`/`get_feedback_period_analytics` (`DATABASE_SCHEMA.md`) compute every statistic inside one tenant-scoped function call per page, superseding round 1's page-by-page row fetching once a round-2 review (R2-02/R2-03) confirmed that approach still had both a silent row-count ceiling and `OFFSET`-pagination inconsistency under concurrent writes — see `DECISIONS.md` for why round 1 chose page-fetching first and what changed.
- **`database.types.ts` is hand-written**, not generated via `supabase gen types` (no local Docker environment available), and is updated by hand alongside every migration.
- **Base UI, not Radix**, per the installed shadcn preset — component APIs (`render` prop instead of `asChild`, etc.) differ accordingly.
- **`priority` is a Postgres generated column** (`feedback.priority`, derived from `rating`), not computed in application code, so it can never drift from the rating that produced it.
- **Column-protecting triggers ship as two migrations, not one, when the column already has a production consumer.** The alert-cooldown and notification-email-change triggers (round 3, R3-05) are each split into an "expand" migration (new columns/functions, no enforcement yet) and a later "enforce" migration (the trigger itself) — applying both together would break currently-deployed application code that still writes the protected column(s) directly, in the gap between the migration landing and new code deploying. See `DATABASE_SCHEMA.md` § "Rollout ordering."
- **The paywall's trial expiry is computed at request time from `trial_ends_at`, not a stored "expired" status a cron job flips.** No scheduled task exists or is needed — `isBillingActive()` just compares against `now()` on every dashboard request, per the product skill's "avoid unnecessary infrastructure."
- **A single flat plan, not tiers.** One price, unlimited locations/cards — matches the MVP guidance against premature tiering; the schema (`organization_billing.status`/`stripe_subscription_id`) doesn't assume a plan count of one, so introducing tiers later is additive, not a rework.

## What's deliberately not built (see `DECISIONS.md` for the reasoning behind each)

- Redis/IP-based rate limiting on the public submission endpoint — a database-backed rate limit (`submit_feedback_atomic`, 20 submissions per card per 5 minutes) is built and enforced; Redis specifically was evaluated and skipped as unnecessary infrastructure once the same limit could be enforced inside the existing atomic database function, per the product skill's "avoid unnecessary infrastructure."
- An organization switcher (schema supports multi-org membership; UI always resolves the earliest-joined org).
- Role-gated dashboard authorization (owner/admin/manager/staff exist in the schema; no invite flow exists yet, so only "owner" is ever actually assigned).
- File-upload UI for the organization logo (a pasted URL field instead).
- ~~Verified `notification_email` recipients for negative-feedback alerts.~~ **Done in round 3** (R3-03) — a real confirmation-link flow, not just the org-wide budget mitigation this line originally described. See `SECURITY.md` § "Notification recipient verification" and `DECISIONS.md` § "R2-08."
