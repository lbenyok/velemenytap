# Test Plan

## Automated

`npm run test` (Vitest). Covers pure logic only — nothing that needs a database, a browser, or Next.js's server runtime:

- **`features/analytics/aggregate.test.ts`** — `ratingDistribution`, `dailySeries`, `resolvedStats`, `byLocation`, `byCard`. Zero-row/zero-division edge cases, UTC day bucketing, unknown-id fallbacks.
- **`features/feedback/schema.test.ts`** — the public submission zod schema (`features/feedback/schema.ts`, extracted from `actions.ts` specifically so it's importable without pulling in `server-only`/`next/server`). Includes the **review-gating regression test at the schema level**: `it.each([1, 2, 3, 4, 5])("accepts rating %i", ...)` asserts the validator itself has no rating-dependent branching — every rating is equally valid input, which is the ground floor the CTA-visibility guarantee below is built on.
- **`lib/sentry-redact.test.ts`** — the `beforeSend` hook that strips `feedback_text`/`internal_note` from every Sentry event before it's sent (`SECURITY.md` § Error handling / logging). Covers request-body/extra-context/breadcrumb redaction, non-sensitive fields passing through untouched, and a circular-reference case that must not hang.

`npm run typecheck` and `npm run lint` run clean on every change (not test suites, but part of the same verification gate — see `Definition of Done` in the product skill).

### What's deliberately not covered by Vitest

Anything that touches Supabase, RLS, Server Actions, cookies, or rendered UI — those need a real database and/or a real browser, which Vitest (running plain Node, no `react-server` condition) can't provide; that's what the e2e suite below is for. `features/notifications/negative-feedback-alert.ts`'s `isNegativeRating()` is pure but wasn't extracted like the feedback schema was, since it's a one-line threshold check with low drift risk.

## e2e (Playwright)

`npm run test:e2e`. Full detail in `e2e/README.md`; summary here.

- **`e2e/review-gating.spec.ts`** — the product skill's Review-Gating Regression Test, automated for real: for each rating 1–5, load `/r/{publicId}` in a real browser, submit that rating, and assert the "Leave a Google review" CTA is visible with the correct `href`. Plus a duplicate-submission test (same card, same browser context, rejected on the second attempt).
- Runs against a real, disposable org/location/five-cards seeded before the suite (`e2e/support/seed.ts`) and deleted after — **against the same Supabase project used for local dev**, not an isolated Docker stack. See `DECISIONS.md` for why, and the note in `e2e/README.md` about manually checking for orphaned `E2E Review Gating %` orgs if a run is killed mid-suite.
- Runs locally against `npm run dev` (Playwright's `webServer` starts it automatically) and in CI (`.github/workflows/ci.yml`'s `e2e` job) — the CI job needs `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY` as repository secrets, and skips (not fails) if they're not yet configured.

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

- **No tenant-isolation automated test.** Verified manually in earlier phases (organization A cannot read organization B's data) but not codified as a repeatable test. Would need a second real Supabase test org and either RLS-level SQL tests or an integration test hitting the real database — both meaningfully more setup than the Vitest unit tests above.
- **No automated notification test.** "Qualifying negative feedback triggers an alert; positive feedback doesn't" is currently verified by reading `features/notifications/negative-feedback-alert.ts` and the `isNegativeRating` threshold, not by a test that actually asserts an email was (or wasn't) sent.
