# Test Plan

## Automated

`npm run test` (Vitest, 110 tests / 7 files). Covers pure logic only — nothing that needs a database, a browser, or Next.js's server runtime:

- **`features/analytics/aggregate.test.ts`** — `ratingDistribution`, `dailySeries`, `resolvedStats`, `byLocation`, `byCard`. Zero-row/zero-division edge cases, UTC day bucketing, unknown-id fallbacks.
- **`features/feedback/schema.test.ts`** — the public submission zod schema (`features/feedback/schema.ts`, extracted from `actions.ts` specifically so it's importable without pulling in `server-only`/`next/server`). Includes the **review-gating regression test at the schema level**: `it.each([1, 2, 3, 4, 5])("accepts rating %i", ...)` asserts the validator itself has no rating-dependent branching — every rating is equally valid input, which is the ground floor the CTA-visibility guarantee below is built on.
- **`lib/sentry-redact.test.ts`** (22 tests) — the `beforeSend` hook that strips `feedback_text`/`internal_note` from every Sentry event before it's sent (`SECURITY.md` § Error handling / logging). Canary-based: asserts against the fully serialized event, not just specific keys — request-body dropping, extra/context/breadcrumb key-based redaction, JSON-stringified content, repeated (non-circular) references, circular references, and pathologically deep structures.
- **`lib/safe-redirect.test.ts`** (29 tests) — the shared open-redirect guard (`SECURITY.md` § Redirect safety): valid internal paths, absolute external URLs, protocol-relative URLs, the backslash bypass and its variants, control characters, encoded variants, and malformed input.
- **`features/analytics/fetch-all-rows.test.ts`** (7 tests) — the pagination helper that fixed the analytics row-cap truncation (`SECURITY.md`, `DECISIONS.md`): single-page, multi-page with parallel remaining-page fetches, the `maxRows` ceiling, error handling, and a short-first-page edge case.
- **`features/billing/status.test.ts`** (13 tests) — `isBillingActive()`, the paywall's entire access decision: no billing row, an active Stripe subscription, a not-yet-expired no-card trial, an expired one, a genuine Stripe-side trial (subscription exists, status `trialing`), and every inactive Stripe status (`past_due`/`canceled`/`incomplete`/`incomplete_expired`/`unpaid`/`paused`).
- **`app/api/webhooks/stripe/route.test.ts`** (9 tests) — the webhook handler with `stripe`/the admin client mocked: missing/invalid signature rejected before touching the database, a genuine event updates the org's billing row, a duplicate event id is a no-op (not reapplied), a non-duplicate insert failure asks Stripe to retry (5xx), the `stripe_customer_id` fallback lookup when subscription metadata is missing, a resolvable-organization miss no-ops rather than crashing, an unrecognized future Stripe status maps to `incomplete` instead of failing the update, and an irrelevant event type is acknowledged without action.

`npm run typecheck` and `npm run lint` run clean on every change (not test suites, but part of the same verification gate — see `Definition of Done` in the product skill).

### What's deliberately not covered by Vitest

Anything that touches Supabase, RLS, Server Actions, cookies, or rendered UI — those need a real database and/or a real browser, which Vitest (running plain Node, no `react-server` condition) can't provide; that's what the e2e suite below is for. `features/notifications/negative-feedback-alert.ts`'s `isNegativeRating()` is pure but wasn't extracted like the feedback schema was, since it's a one-line threshold check with low drift risk.

## e2e (Playwright)

`npm run test:e2e`, against a **dedicated, isolated Supabase test project** (`.env.test.local`, gitignored) — not the shared dev/production project. See `e2e/README.md` for the setup and `DECISIONS.md` for why this changed from the original shared-project approach.

**The list below predates several rounds of additions and is not the authoritative current file list** — `e2e/README.md` is (16 spec files as of this branch; it names and describes every one). Kept here for the tests with enough narrative detail to be worth repeating, plus the newest addition:

- **`e2e/billing-paywall.spec.ts`** — the subscription paywall gates the dashboard (a lapsed org is redirected from any `/dashboard/*` route to `/dashboard/billing`, which itself never redirects) but never the public product: feedback submission through `/r/{publicId}` keeps working, unauthenticated, for an organization with an inactive subscription. See `SECURITY.md` § Billing.

- **`e2e/review-gating.spec.ts`** — the product skill's Review-Gating Regression Test, automated for real: for each rating 1–5, load `/r/{publicId}` in a real browser, submit that rating, and assert the "Leave a Google review" CTA is visible with the correct `href`. Plus a duplicate-submission test (same card, same browser context, rejected on the second attempt).
- **`e2e/tenant-isolation.spec.ts`** — Org A's own signed-in, RLS-bound client cannot read or write any of Org B's organization/location/nfc_card/feedback/membership rows, through direct API calls, not just the app's own query shapes.
- **`e2e/feedback-and-card-integrity.spec.ts`** — an org member cannot rewrite a feedback row's `rating`/`feedback_text` or relocate an `nfc_card`'s `location_id` via direct `UPDATE`, but can still edit `status`/`internal_note`/`display_name`.
- **`e2e/public-submission-safety.spec.ts`** — a card deactivated between page load and submission is caught atomically (not just at page load); the per-card rate limit rejects a 21st submission within its window; the alert-cooldown claim lets exactly one of two concurrent attempts through.
- **`e2e/feedback-pagination.spec.ts`** — 25 rows seeded with an identical `created_at` all appear exactly once across two inbox pages, none skipped or duplicated.
- **`e2e/analytics-row-cap.spec.ts`** — 1200 real rows seeded; the dashboard overview shows 1200, not PostgREST's 1000-row cap.
- **`e2e/organization-onboarding.spec.ts`** — one call creates exactly one org+membership with an accent-stripped slug; a second call for the same user is a no-op; two concurrent calls for the same user still produce exactly one organization; a slug collision falls back correctly; the real onboarding UI works end-to-end.
- **`e2e/redirect-safety.spec.ts`** — drives the real login and email-confirmation flows against the open-redirect backslash bypass.
- Runs locally against `npm run dev` (Playwright's `webServer` starts it automatically, with the isolated project's env injected) and in CI (`.github/workflows/ci.yml`'s `e2e` job) — the CI job needs `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY` as repository secrets, pointed at the isolated project (**confirm this was updated** — they may still point at the old shared project), and skips (not fails) if they're not yet configured.

## Manual (performed this session, against a real linked Supabase project and a real browser)

Every item below was executed end-to-end in Phase 14 verification, not merely code-reviewed: a QA account was created, confirmed, and used to build a real organization/location/NFC card, then deleted afterward (`DECISIONS.md` has no entry for this since it's routine hygiene, not a product decision).

- **Review-Gating Regression Test (the one from the product skill, run for real):** submitted 1-star feedback through the public `/r/{publicId}` page → confirmed the "Leave a Google review" CTA rendered identically to how it does for a positive rating. (5-star was also submitted, blocked by the duplicate-cookie guard as expected — see below — but the 1-star → CTA-present check is the one that matters most and was directly observed.)
- **Duplicate-submission cookie:** submitted once successfully, immediately retried on the same card → rejected with "You've already sent feedback for this visit." No second row was written (confirmed via the feedback inbox showing exactly one item).
- **Feedback inbox:** priority badge ("High priority") rendered correctly for a rating-≤2 item; unresolved-high-priority row visibly highlighted; NFC card filter dropdown populated with "Front counter (Main Street)" and correctly filtered the list when selected; detail dialog showed the same priority badge next to the star rating.
- **Settings page:** business name / notification email / logo URL saved via the form, "Saved." confirmation shown, values persisted correctly across a full page reload.
- **Overview page:** all five stat tiles (Total, Average, Today, This week, Unresolved negative) and the rating-distribution bar rendered correctly for real data.
- **Onboarding → dashboard flow:** signup → email confirmation (via admin API, since no email inbox was available in this environment) → login → organization creation → dashboard landing, all worked without error.

## Manual (performed in earlier phases, not re-verified this session)

Locations CRUD, NFC card CRUD (activate/deactivate), analytics page (volume-over-time, location/card comparisons), auth (signup/login/signout), tenant-isolation smoke checks. See prior commit history for what was verified when each of these was originally built.

## Review-Gating Regression Test (standing checklist)

Per the product skill, re-run this whenever the public rating/review flow changes:

- [ ] 1 star → Google Review CTA available, same placement/prominence as other ratings
- [ ] 2 stars → Google Review CTA available
- [ ] 3 stars → Google Review CTA available
- [ ] 4 stars → Google Review CTA available
- [ ] 5 stars → Google Review CTA available
- [ ] No code path conditions CTA visibility on rating, sentiment, or AI analysis
- [ ] `features/feedback/schema.test.ts`'s `it.each([1,2,3,4,5])` still passes (schema-level guard)
- [ ] `npm run test:e2e` (`e2e/review-gating.spec.ts`) still passes (browser-level guard, now automated in CI on every push/PR)

## CI

`.github/workflows/ci.yml` runs on every push/PR to `master`: `typecheck` → `lint` → `npm run test` (Vitest) unconditionally, then `npm run test:e2e` (Playwright) if the required Supabase secrets are configured on the repo (see `e2e/README.md`) — otherwise that job skips rather than failing CI outright.

## Known gaps (tracked, not silently skipped)

- ~~No tenant-isolation automated test.~~ **Resolved** — `e2e/tenant-isolation.spec.ts`.
- **No automated notification test.** "Qualifying negative feedback triggers an alert; positive feedback doesn't" is currently verified by reading `features/notifications/negative-feedback-alert.ts` and the `isNegativeRating` threshold, not by a test that actually asserts an email was (or wasn't) sent. The new alert-cooldown *claim mechanism* (the atomic `UPDATE ... WHERE ... RETURNING` pattern) is tested directly (`e2e/public-submission-safety.spec.ts`), but sending the actual email through Resend remains unverified by any automated test — this test project deliberately has no `RESEND_API_KEY` configured (`e2e/README.md`), so exercising the real send would need either a second, Resend-key-bearing test configuration or a mocked Resend client.
