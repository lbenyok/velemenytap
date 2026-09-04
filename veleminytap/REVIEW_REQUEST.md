# Review Request

Written for an independent senior engineer picking this up cold (addressed to ChatGPT, per the working agreement — no prior context assumed). This is a full architecture/security/correctness review request, not a delta review of one feature. Start here, then `PRODUCT_SPEC.md` (what this is and why), `ARCHITECTURE.md` (how it's built), `DATABASE_SCHEMA.md` (tables/RLS in full), `SECURITY.md`, and `DECISIONS.md` (the reasoning behind every deliberate MVP shortcut — read this before flagging something as a gap; it may already be a documented, reasoned tradeoff).

**Review this commit:** `a3d5ce12ddba6a035e5866738d1d4500a4b4fdb9` (`a3d5ce1`) on `master`, repo `github.com/lbenyok/velemenytap`.
**Diff range for "what's new since the last review pass":** `c99bbca..a3d5ce1` (16 commits, 89 files, +11355/-6136 — see § Commits in this range below). No prior formal review of this codebase has actually been performed yet; this is the first real request.
**This pass added no new functionality** — it re-ran the full verification suite from a clean state and rewrote this document. The code under review is exactly what's on `master` right now.

---

## 1. Current architecture summary

Next.js 16 (App Router, Turbopack, React 19, TypeScript strict) on Vercel, backed by Supabase (Postgres + Auth, Row Level Security as the tenant boundary). Tailwind v4 + shadcn/ui (Base UI primitives, not Radix). Resend for transactional email. Sentry for error monitoring. Vitest for unit tests, Playwright for e2e, GitHub Actions for CI.

Multi-tenant hierarchy: `organization → location → nfc_card → feedback`, plus `organization_membership` linking `auth.users` to organizations. Every tenant-owned table is RLS-protected via a single `SECURITY DEFINER` helper (`private.is_org_member(organization_id)`), not application-level filtering.

Two request paths matter most:
- **Dashboard (authenticated):** Server Components read through an RLS-bound Supabase client carrying the user's cookies; every query is subject to RLS as that user. Mutations go through Server Actions using the same client — no privileged bypass on this side.
- **Public feedback submission (unauthenticated):** the one deliberate RLS bypass in the system (§ 9) — see there for the full reasoning.

Full detail: `ARCHITECTURE.md`.

## 2. Implemented features

- Email/password auth (signup, login, logout, email confirmation), one organization per user (schema supports multi-org membership; no switcher UI).
- Organizations: name, notification email, logo URL (Settings page).
- Locations: name, address, Google Review URL, active/inactive.
- NFC cards: belong to a location, unguessable `public_id` (UUID, not the internal sequential id), active/inactive, multiple cards per location.
- Public feedback flow (`/r/[publicId]`): unauthenticated, validates card + location are active at submission time (not just page-load time), cookie-based duplicate-submission guard, Google Review CTA identical across all five ratings (the product's central invariant — § 10).
- Feedback inbox: filterable (status/rating/location/NFC card/date range), cursor-paginated, per-item status + internal note, `priority` (generated column from rating) surfaced as a badge with unresolved-high-priority rows highlighted.
- Negative-feedback email alerts (rating ≤ 2): non-blocking (`after()`), routed to `notification_email` if set, else fanned out to owner/admin/manager members' emails.
- Analytics: volume-over-time, average-rating trend, rating distribution, resolved-vs-unresolved, per-location and per-NFC-card comparison tables.
- Overview dashboard: total/average/today/this-week/unresolved-negative stat tiles, rating distribution, recent feedback.
- Settings page: business name, notification email, logo URL (pasted URL, not an upload — § 14).
- Public marketing homepage (`/`) — hero with a live interactive replica of the actual rating flow, proof row (all 5 ratings → same link), how-it-works, target verticals, dashboard-feature overview, final CTA.
- Full Hungarian localization (all user-facing text, `<html lang="hu">`) and a brand rebrand (navy ink + blue-to-cyan gradient, matching the product's real logo/icon) — done in-place, not via an i18n framework (§ 14).
- Sentry error monitoring (client/server/edge) with a `beforeSend` redaction hook stripping feedback content before it ever leaves the app.
- Playwright e2e (review-gating regression, automated) + GitHub Actions CI (typecheck/lint/Vitest always; Playwright against a production build once repo secrets are configured) — currently green.

## 3. Repository structure

Git repo root is **one level above** the app (`C:\...\Biznisz`, containing unrelated brand-asset files and `.claude/` config) — `.git` and `.github/workflows/ci.yml` live there; the actual Next.js app is in `veleminytap/`. All paths below are relative to `veleminytap/`.

```
app/                        routes (App Router)
  dashboard/                 authenticated: layout, page (Overview), analytics, feedback, locations, nfc-cards, settings
  r/[publicId]/               public NFC landing page
  login/ signup/ auth/         auth flow (login, signup, check-email, confirm route, auth-code-error)
  onboarding/                  org-creation flow for new users
  page.tsx                     public marketing homepage
  global-error.tsx             Sentry-wired root error boundary
  not-found.tsx                custom 404
features/                    feature-oriented domain code (not layered by technical role)
  auth/ organizations/ locations/ nfc-cards/ feedback/ analytics/ notifications/ marketing/
  each typically: actions.ts (Server Actions), *-form.tsx, *-table.tsx, page-level components
lib/
  supabase/                    server.ts (RLS-bound client), admin.ts (secret-key client, server-only guarded), client.ts, database.types.ts (hand-written)
  sentry-redact.ts             beforeSend redaction hook + its own unit test
e2e/                         Playwright: review-gating.spec.ts + support/ (seed.ts, env.ts)
supabase/migrations/          3 imperative SQL migrations, applied in order
proxy.ts                     protect-by-default auth gate (renamed from middleware.ts)
instrumentation.ts, instrumentation-client.ts, sentry.*.config.ts   Sentry wiring
playwright.config.ts, vitest.config.ts
```

Full file listing is in the repo; nothing hidden or generated-and-gitignored that matters for review beyond the usual (`node_modules`, `.next`, `.env.local`).

## 4. Database tables

All in the `public` schema unless noted. Defined across 3 migrations (§ 12).

| Table | Belongs to | Notes |
|---|---|---|
| `organizations` | — | `name`, `slug` (unique), `settings jsonb` (unused), `notification_email`, `logo_url`, timestamps |
| `organization_memberships` | org + `auth.users` | `role` ∈ `{owner,admin,manager,staff}` — only `owner` is ever actually assigned (no invite flow exists) |
| `locations` | org | `name`, `address`, `google_review_url` (nullable — never fabricated if absent), `status` ∈ `{active,inactive}` |
| `nfc_cards` | location (+ denormalized org) | `public_id uuid` (random, unguessable, distinct from internal sequential `id`), `display_name`, `status` |
| `feedback` | nfc_card (+ denormalized org, location) | `rating smallint` (DB-constrained 1–5), `feedback_text` (≤5000 char DB constraint, ≤1000 enforced in the zod schema), `status` ∈ `{new,in_progress,resolved}`, `internal_note`, `priority` — **generated column** (`GENERATED ALWAYS AS (...) STORED`, `high`/`medium`/`normal` from `rating`, never independently writable) |
| `profiles` | `auth.users` (1:1) | `full_name` only; auto-created by an `on_auth_user_created` trigger; **nothing in the app reads this table yet** |
| `private.*` (non-exposed schema) | — | helper functions only, not real tables: `is_org_member`, `set_updated_at`, `prevent_organization_id_change`, `validate_nfc_card_organization`, `validate_feedback_consistency`, `handle_new_user` |

Indexes: every FK used in an RLS predicate is indexed; `feedback (organization_id, created_at desc)` backs the newest-first inbox, `feedback (organization_id, status)` backs unresolved filtering, `feedback (organization_id, priority)` backs priority filtering.

## 5. RLS policies

RLS is enabled on every table in `public`. Uniform shape: `to authenticated using (private.is_org_member(organization_id))`, with a matching `with check` on insert/update policies.

- `organizations`: `select`, `update` (any member — no owner/admin gate; § 14). **No `insert` policy** — org creation goes through the admin client (§ 9).
- `organization_memberships`: `select` only (see own org's roster). **No `insert`/`update`/`delete` policy** — membership creation is admin-client-only, tied to org creation.
- `locations`: `select`, `insert`, `update`. No `delete` policy (deactivate via `status`, not delete).
- `nfc_cards`: `select`, `insert`, `update`. Same no-delete pattern.
- `feedback`: `select`, `update` only. **No `insert`/`delete` policy for `anon` or `authenticated`** — the only write path is the admin client in `submitFeedbackAction` (§ 9).
- `profiles`: `select`/`update` own row only (`auth.uid() = id`). No `insert` policy — created exclusively by the `SECURITY DEFINER` trigger.

**Defense beyond RLS** (all in migration 1): `prevent_organization_id_change` (blocks moving a row between orgs via `UPDATE`, relevant for a hypothetical multi-org member), `validate_nfc_card_organization` and `validate_feedback_consistency` (re-derive the denormalized `organization_id`/`location_id` from the true parent row and reject inserts/updates where they disagree — this is what keeps the RLS-performance denormalization from silently drifting into a tenant-boundary bug).

`private.is_org_member` is `SECURITY DEFINER`, `stable`, `set search_path = ''`, lives in the non-exposed `private` schema, and its `EXECUTE` grant is revoked from `public` and re-granted only to `authenticated` — per the Supabase security checklist for `SECURITY DEFINER` functions in general-purpose schemas.

**§ 16 asks the reviewer to independently stress-test this section** — it's the highest-consequence area in the codebase.

## 6. Authentication / authorization approach

Supabase Auth, email/password. Server-side identity via `getClaims()` (not `getUser()`/`getSession()`, per current Supabase guidance). `proxy.ts` is protect-by-default: every route not in `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`) requires a session, redirecting to `/login` with a `next` param otherwise.

Authorization is entirely tenant-scoped (org membership via RLS), not role-scoped — every member can do everything within their org (§ 14 explains why: no invite flow exists, so `manager`/`staff` roles can never actually be assigned, making role-gating dead/untestable code). No `user_metadata`/`raw_user_meta_data` is used in any authorization decision.

**Known bug, not introduced this round (§ 15):** `app/auth/confirm/route.ts` redirects to a raw `next` query param post-verification with no same-origin check — an open redirect. `features/auth/actions.ts`'s `signInAction` validates the equivalent `next` param correctly; the confirm route does not.

## 7. Public feedback submission flow

`app/r/[publicId]/page.tsx` → `lookupPublicCard(publicId)` (server-side, via `card-lookup.ts`) resolves org/location/card or renders a "not found"/"inactive" message. `FeedbackFlow` (client component) renders `StarPicker` + optional textarea, posts to `submitFeedbackAction` (`features/feedback/actions.ts`):

1. Validates input with the extracted `feedbackSchema` (`features/feedback/schema.ts` — zod, unit-tested).
2. Checks an `HttpOnly`, `secure`, card-path-scoped cookie (`fb_sent_{publicId}`, 5-minute window) to reject an accidental duplicate tap. No personal data in the cookie, just presence.
3. Re-resolves the card server-side (never trusts client-supplied org/location/card ids) and re-checks it's still active — a card could have been deactivated between page load and submit.
4. Inserts via the **admin (secret-key) client** — the one deliberate RLS bypass (§ 9).
5. Sets the duplicate-guard cookie only after a successful insert.
6. If `rating ≤ 2`, schedules `sendNegativeFeedbackAlert` via `after()` — never awaited by the response path, so a slow/failed email can't affect the customer-facing result.
7. Returns `{ organizationName, googleReviewUrl }` on success — the confirmation screen always renders the CTA if `googleReviewUrl` is non-null, regardless of `rating` (§ 10).

## 8. Google Review link logic

The location's `google_review_url` (nullable, never fabricated — `PRODUCT_SPEC.md`) is passed straight through from the card's location to the confirmation screen. **No code path conditions its presence or prominence on `rating`, sentiment, or status.** This is the product's single most important invariant (`PRODUCT_SPEC.md` § "The one rule that overrides everything else") — the entire premise is that positive and negative customers get identically-treated review opportunities, both because gating violates Google's own review-solicitation policy and because it's the product's ethical premise.

Verified three ways: (a) `features/feedback/schema.test.ts`'s `it.each([1,2,3,4,5])` — the validator itself has no rating-dependent branching; (b) `e2e/review-gating.spec.ts` — a real browser submits each of the 5 ratings against a real seeded card and asserts the CTA's presence and `href`; (c) manual verification in production this session (1-star and 5-star, both showing the identical CTA). **§ 16 asks the reviewer to independently trace this path** rather than trust the tests.

## 9. Security-sensitive files

- **`lib/supabase/admin.ts`** — the secret-key client. `import "server-only"` guarded (build-time guarantee it can't enter a client bundle). Used in exactly two places: `submitFeedbackAction` (public insert, no authenticated user to check `auth.uid()` against) and `sendNegativeFeedbackAlert` (reads `notification_email`/member emails, read-only, server-only). Nowhere else. **§ 16 asks the reviewer to independently grep for any other use.**
- **`proxy.ts`** — the entire app's authentication gate; see § 6.
- **`app/auth/confirm/route.ts`** — open redirect, see § 6/§ 15.
- **`features/feedback/actions.ts`** — the only public unauthenticated write path in the system.
- **`lib/sentry-redact.ts`** — the only thing standing between `feedback_text`/`internal_note` and Sentry's servers on any exception. Unit-tested (`lib/sentry-redact.test.ts`, 6 cases including a circular-reference case) but worth an independent look at whether the field-name-based redaction (`feedback_text`, `feedbackText`, `internal_note`, `internalNote`) could miss a shape it wasn't anticipating (e.g. serialized JSON string containing the text rather than a matching key).
- **`supabase/migrations/*.sql`** — see § 4/§ 5; this is where the actual tenant boundary lives, not in application code.
- **`.env.example`** vs **`.env.local`** (gitignored) — confirm no real secret ever made it into a commit; `git log -p -- .env.local` should show nothing (the file has never been tracked).

## 10. API / Server Actions / routes

All mutations are Next.js Server Actions (`"use server"`), not a separate REST/API layer. One real route handler:

| File | Export | Auth | Purpose |
|---|---|---|---|
| `app/auth/confirm/route.ts` | `GET` | none (pre-auth) | Email OTP verification, then redirect — **has the open-redirect bug**, § 6 |
| `features/auth/actions.ts` | `signUpAction`, `signInAction`, `signOutAction` | none / session | Auth flow |
| `features/organizations/actions.ts` | `createOrganizationAction` | session, no org yet | Onboarding — admin client, no RLS insert policy exists for this (§ 5) |
| `features/organizations/settings-actions.ts` | `updateOrganizationSettingsAction` | session + org member | RLS-bound, any member can edit (§ 14) |
| `features/locations/actions.ts` | `createLocationAction`, `updateLocationAction`, `setLocationStatusAction` | session + org member | RLS-bound |
| `features/nfc-cards/actions.ts` | `createNfcCardAction`, `updateNfcCardAction`, `setNfcCardStatusAction` | session + org member | RLS-bound; validates the target location actually belongs to the caller's org before insert/update, on top of the DB trigger |
| `features/feedback/actions.ts` | `submitFeedbackAction` | **none — public** | § 7, § 9 |
| `features/feedback/inbox-actions.ts` | `updateFeedbackAction` | session + org member | Status/internal-note updates |

## 11. Migrations

Imperative, in `supabase/migrations/`, applied in order (no declarative-schema workflow):

1. `20260903150741_core_schema_and_rls.sql` — all core tables, indexes, triggers, RLS policies (§ 4/§ 5).
2. `20260903161454_add_feedback_internal_note.sql` — adds `feedback.internal_note` (no RLS change needed; existing `feedback_update` policy already covers it).
3. `20260903173818_add_priority_profiles_org_settings.sql` — `feedback.priority` (generated column), `organizations.notification_email`/`logo_url`, `profiles` table + trigger.

Never hand-edited in production outside these files — see `DATABASE_SCHEMA.md`'s Database Change Workflow.

## 12. Relevant tests

**Vitest** (`npm run test`, 30 tests / 3 files, pure logic only — no DB, no browser):
- `features/analytics/aggregate.test.ts` (16 tests) — `ratingDistribution`, `dailySeries`, `resolvedStats`, `byLocation`, `byCard`; zero-row/zero-division edges, UTC day bucketing, unknown-id fallbacks.
- `features/feedback/schema.test.ts` (8 tests) — the public submission zod schema, including the review-gating check (§ 8).
- `lib/sentry-redact.test.ts` (6 tests) — the redaction hook, including a circular-reference case.

**Playwright** (`npm run test:e2e`, 6 tests / 1 file, against the real linked Supabase project — no isolated test environment, § 14):
- `e2e/review-gating.spec.ts` — 5 tests (one per rating) submitting through the real public page and asserting the CTA; 1 test for the duplicate-submission cookie guard. Seeds and tears down its own disposable org/location/5-cards (`e2e/support/seed.ts`); teardown confirmed working this pass.

**Not covered by any automated test** (§ 13): tenant isolation (cross-org access denial), the negative-feedback alert email actually being sent/not-sent correctly, any dashboard CRUD flow beyond what Vitest's pure-logic tests touch, auth flows themselves.

## 13. Known bugs

1. **Open redirect in `app/auth/confirm/route.ts`** (§ 6) — the one confirmed, concrete bug found this pass. Not part of this round's diff; pre-existing since the original auth-flow commit (`ea63f03`). Left unfixed deliberately per this pass's "no new functionality" scope — flagging for the reviewer and for a follow-up fix.

No other confirmed bugs found this pass; the below are risks/gaps, not confirmed defects.

## 14. Deliberate MVP shortcuts (documented in `DECISIONS.md`, not oversights)

- Single organization per signed-in user (schema supports more; no switcher UI).
- No role-gated authorization — every org member can do everything (no invite flow exists yet, so `manager`/`staff` can never actually be assigned).
- Organization logo is a pasted URL, not a Storage upload.
- `notification_email` **overrides** (not supplements) the owner/admin/manager email fan-out when set.
- Cookie-based duplicate-submission guard instead of IP/Redis rate limiting (§ 15 — SECURITY.md has the full threat-model reasoning).
- Single `internal_note` column instead of a `feedback_notes` table (no multi-person concurrent workflow exists yet to need it).
- `priority` is a generated column, not application-computed (a correctness choice, not a shortcut).
- UTC day boundaries for "today"/"this week" (no per-org timezone field).
- Hungarian localization done as in-place string replacement, not an i18n framework — no English fallback or toggle exists; this is a single-language product by design right now.
- e2e tests run against the same Supabase project as dev/production — no isolated environment (Docker-based local Postgres or a second Supabase project).
- Sentry has no source-map upload configured (no `SENTRY_AUTH_TOKEN`) — stack traces in the dashboard are minified.

## 15. Known risks

- **Anti-spam posture**: the public feedback endpoint has no rate limiting beyond the duplicate-tap cookie (which is trivially bypassable by not sending cookies). Acceptable for an MVP with no real traffic yet; worth a second opinion on whether it's adequate before more businesses depend on it (`SECURITY.md` has the full reasoning for why IP/Redis limiting was skipped).
- **No tenant-isolation automated test** — cross-org access denial is only verified by the RLS policy design itself and prior manual testing, not by a repeatable test that would catch a regression.
- **e2e tests write to the shared dev/prod Supabase project** — namespaced (`E2E Review Gating {timestamp}` orgs) and torn down in `afterAll`, but a killed/crashed run can leave orphaned rows (observed once this session, self-resolved; documented in `e2e/README.md`). Not acceptable once real customer data lives in the same project.
- **Sentry redaction is field-name-based** (§ 9) — a shape it doesn't anticipate could leak feedback content into error reports.
- **The open redirect** (§ 6, § 13).

## 16. Where to be especially critical

In priority order:

1. **RLS + trigger correctness (§ 5).** Independently construct the cross-tenant attack scenarios rather than trusting the design narrative: a user who is a member of two organizations, a crafted `location_id`/`nfc_card_id` on an insert/update, a role escalation attempt. This is the single highest-consequence area in the codebase.
2. **The admin-client bypass (§ 9).** Confirm it's genuinely only used in the two documented places, and that the server-side re-validation in `submitFeedbackAction` is actually sufficient — could a deactivated/deleted card, a card from a different org than claimed, or a race between the active-check and the insert produce a wrong result?
3. **The Google Review non-gating guarantee (§ 8, § 10).** This is the product's core ethical/business premise, not just a feature — trace every code path that touches `googleReviewUrl` rendering and confirm none of them could ever key off `rating`.
4. **The open redirect (§ 6, § 13)** — assess real-world exploitability (what does an attacker actually gain by redirecting a just-verified session?) and the right fix.
5. **Whether the cookie-only anti-spam posture (§ 15) is actually defensible**, or whether it needs to be prioritized before the next round of feature work rather than after.
6. **The Sentry redaction hook's completeness (§ 9)** — is field-name matching the right approach, or does it need a content-shape-agnostic strategy?

## 17. Commands used to test the system (all re-run clean this pass)

```bash
npm install
npm run typecheck     # tsc --noEmit — clean
npm run lint           # eslint — clean
npm run test            # vitest run — 30/30 passed
npm run test:e2e        # playwright test — 6/6 passed, real Supabase project, cleanup confirmed
npm run build            # next build — clean, all routes compile
```

`npm run dev` + manually exercising `/r/{a real nfc_cards.public_id}` was also done this session (not re-run this pass, since no code changed) — see `TEST_PLAN.md` for the full manual-verification log.

## 18. Commits in this range (`c99bbca..a3d5ce1`)

```
47ec557 feat: add feedback priority, NFC card filter, overview stats, and settings
b9baf5f test: add Vitest unit tests for aggregation logic and feedback schema
1daf267 docs: add product, architecture, security, decisions, test plan, and status docs
6b859e0 docs: record Resend wiring and its shared-sender delivery limitation
92ee007 feat: add Sentry error monitoring with feedback-content redaction
883f8cf docs: record Sentry integration across the documentation suite
506ec61 feat: add Playwright e2e tests and a CI pipeline
22ec1bb docs: record Playwright/CI across the documentation suite
c7a4d74 fix: scope CI's working-directory default per-job, not workflow-wide
2681c26 ci: trigger a run to verify the Playwright e2e job with repo secrets
028317a fix: build once and use next start for e2e in CI, not next dev
14f5b34 fix: check all three e2e secrets are set, not just SUPABASE_SECRET_KEY
d337f36 docs: record CI going fully green, including the debugging trail
2ecd848 feat: switch negative-feedback alerts to the verified velemenytap.hu domain
f83519c feat: build the public marketing homepage
a3d5ce1 feat: full Hungarian localization and brand rebrand to match the logo
```

`git diff c99bbca..a3d5ce1` for the full patch; `git log --stat c99bbca..a3d5ce1` for per-file change volume.
