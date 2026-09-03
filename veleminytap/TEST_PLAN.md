# Test Plan

## Automated

`npm run test` (Vitest). Covers pure logic only — nothing that needs a database, a browser, or Next.js's server runtime:

- **`features/analytics/aggregate.test.ts`** — `ratingDistribution`, `dailySeries`, `resolvedStats`, `byLocation`, `byCard`. Zero-row/zero-division edge cases, UTC day bucketing, unknown-id fallbacks.
- **`features/feedback/schema.test.ts`** — the public submission zod schema (`features/feedback/schema.ts`, extracted from `actions.ts` specifically so it's importable without pulling in `server-only`/`next/server`). Includes the **review-gating regression test at the schema level**: `it.each([1, 2, 3, 4, 5])("accepts rating %i", ...)` asserts the validator itself has no rating-dependent branching — every rating is equally valid input, which is the ground floor the CTA-visibility guarantee below is built on.

`npm run typecheck` and `npm run lint` run clean on every change (not test suites, but part of the same verification gate — see `Definition of Done` in the product skill).

### What's deliberately not covered by Vitest

Anything that touches Supabase, RLS, Server Actions, cookies, or rendered UI — those need a real database and/or a real browser, which Vitest (running plain Node, no `react-server` condition) can't provide. `features/notifications/negative-feedback-alert.ts`'s `isNegativeRating()` is pure but wasn't extracted like the feedback schema was, since it's a one-line threshold check with low drift risk; it's exercised indirectly by the manual/e2e checks below.

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

## Known gaps (tracked, not silently skipped)

- **No Playwright/e2e automation yet.** The review-gating check above was performed manually this session, not via an automated browser test. Given this repo has no CI pipeline yet either, an e2e suite without CI to run it in has limited ongoing value — the pragmatic next step is standing up both together rather than one without the other. See `STATUS.md`.
- **No tenant-isolation automated test.** Verified manually in earlier phases (organization A cannot read organization B's data) but not codified as a repeatable test. Would need a second real Supabase test org and either RLS-level SQL tests or an integration test hitting the real database — both meaningfully more setup than the Vitest unit tests above.
- **No automated notification test.** "Qualifying negative feedback triggers an alert; positive feedback doesn't" is currently verified by reading `features/notifications/negative-feedback-alert.ts` and the `isNegativeRating` threshold, not by a test that actually asserts an email was (or wasn't) sent.
