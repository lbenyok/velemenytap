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

**Dashboard (authenticated).** Server Components read through the request-scoped Supabase client (`lib/supabase/server.ts`), which carries the user's cookies, so every query is subject to RLS as that user. `getCurrentOrganization()` (`features/organizations/current.ts`) resolves which org a signed-in user is acting as (see `DECISIONS.md` for the single-org-per-user simplification). Mutations go through Server Actions (`features/*/actions.ts`), using the same RLS-bound client — there is no privileged bypass on the dashboard side.

**Public feedback submission (unauthenticated).** `app/r/[publicId]/page.tsx` reads card/location/org info through `lookupPublicCard` and renders the rating UI. Submission goes through `submitFeedbackAction` (`features/feedback/actions.ts`), a Server Action that:
1. Validates input with zod.
2. Checks a short-lived HttpOnly cookie to reject an accidental duplicate tap.
3. Re-resolves the card server-side (never trusts client-supplied org/location/card ids) and re-checks it's still active.
4. Inserts via the **admin client** (`lib/supabase/admin.ts`, secret key, `import "server-only"` guarded) — this is the one deliberate RLS bypass in the system, because there is no authenticated user for `auth.uid()`-based policies to check. The insert path is narrow: one action, one table, server-validated shape.
5. Schedules the negative-feedback alert email via `next/server`'s `after()`, so a slow or failed email send can never affect the customer-facing response.

**Proxy / route protection.** `proxy.ts` (renamed from the default `middleware.ts`) is protect-by-default: everything except `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`) requires a session, redirecting to `/login` otherwise.

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
supabase/migrations/    imperative SQL migrations, applied in order
```

`features/` is organized by domain, not by technical layer, per the product skill's suggested structure. Do not reorganize without a clear reason.

## Key technical decisions

- **Cursor-based pagination**, not `OFFSET`, for the feedback inbox — stable under concurrent inserts.
- **`database.types.ts` is hand-written**, not generated via `supabase gen types` (no local Docker environment available), and is updated by hand alongside every migration.
- **Base UI, not Radix**, per the installed shadcn preset — component APIs (`render` prop instead of `asChild`, etc.) differ accordingly.
- **`priority` is a Postgres generated column** (`feedback.priority`, derived from `rating`), not computed in application code, so it can never drift from the rating that produced it.

## What's deliberately not built (see `DECISIONS.md` for the reasoning behind each)

- Redis/IP-based rate limiting on the public submission endpoint.
- An organization switcher (schema supports multi-org membership; UI always resolves the earliest-joined org).
- Role-gated dashboard authorization (owner/admin/manager/staff exist in the schema; no invite flow exists yet, so only "owner" is ever actually assigned).
- File-upload UI for the organization logo (a pasted URL field instead).
