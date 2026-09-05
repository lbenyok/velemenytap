# Test Plan

Round-4 finding R4-08: this file previously hardcoded test counts (82 unit / 35 e2e) that had already drifted from reality by two rounds' worth of changes. Exact counts are not repeated here going forward — run `npm run test` / `npm run test:e2e` (or `npx playwright test --list`) for the current numbers rather than trusting a number in prose that nothing keeps in sync automatically.

## Automated: Vitest (`npm run test`)

Pure logic only — nothing that needs a database, a browser, or Next.js's server runtime:

- **`lib/safe-redirect.test.ts`** — the shared open-redirect guard (`SECURITY.md` § Redirect safety): valid internal paths, absolute external URLs, protocol-relative URLs, the backslash bypass, the round-3 dot-segment/double-slash-pathname bypass (R2-01 round 2), control characters, encoded variants, malformed input.
- **`lib/sentry-redact.test.ts`** — the `beforeSend` hook stripping `feedback_text`/`internal_note` from every Sentry event before it's sent. Canary-based: asserts against the fully serialized event, including circular-reference and JSON-stringified-content cases.
- **`features/feedback/schema.test.ts`** — the public submission zod schema, including the **review-gating regression test at the schema level**: `it.each([1,2,3,4,5])` asserts the validator has no rating-dependent branching.
- **`features/analytics/parse-snapshots.test.ts`** — parses `get_feedback_overview_snapshot`/`get_feedback_period_analytics`'s `jsonb` RPC results into typed shapes, discriminating a query error/null result into `{ unavailable: true }` (round-2 R2-04) rather than a silently-empty stats page.
- **`e2e/support/env.test.ts`** — e2e credential resolution (round-2 R2-06, round-3 R3-01): fail-closed on missing config, single-source resolution (never a file/process-env mix), the approved-project allowlist, force-disabled email/telemetry keys.
- **`e2e/support/db-connection.test.ts`** — round-4 R4-04: `SUPABASE_DB_URL`'s CI-mandatory/local-optional split, the approved-project-ref check, unreachable-in-CI failing loud.
- **`app/api/health/route.test.ts`** — round-4 R4-01: `/api/health` reports `ok:false`/503 when release metadata (`VERCEL_GIT_COMMIT_SHA`) is missing in a production/preview environment, `ok:true` locally and whenever a commit SHA is present.

`npm run typecheck` and `npm run lint` run clean on every change — part of the same verification gate as the test suites, not test suites themselves.

### What's deliberately not covered by Vitest

Anything that touches Supabase, RLS, Server Actions, cookies, or rendered UI needs a real database and/or a real browser, which Vitest (plain Node, no `react-server` condition) can't provide — that's what the e2e suite below is for.

## Automated: Playwright e2e (`npm run test:e2e`)

Against a **dedicated, isolated Supabase test project** (`.env.test.local`, gitignored) — never the production project. See `e2e/README.md` for setup and `DECISIONS.md` for why there's no Docker-based local stack instead. Every spec file carries its own doc comment explaining what it verifies and why; this is a map of what exists, not a restatement of each file's reasoning:

| Area | File(s) |
|---|---|
| Review-gating (Google Review CTA identical across ratings 1–5) | `review-gating.spec.ts` |
| Open-redirect fix, both call sites, both round-2/round-3 payloads | `redirect-safety.spec.ts` |
| Cross-tenant isolation (reads, writes, RPCs, dashboard rendering) | `tenant-isolation.spec.ts` |
| Feedback/card column-level immutability (RLS is row-level, not column-level) | `feedback-and-card-integrity.spec.ts` |
| Public submission safety: card-deactivation race, per-card rate limit | `public-submission-safety.spec.ts` |
| Location-deactivation race (round-2 R2-05) — real two-Postgres-connection concurrency | `location-deactivation-race.spec.ts` |
| Feedback inbox cursor pagination under tied timestamps | `feedback-pagination.spec.ts` |
| Analytics: row-count-ceiling removal, single-snapshot consistency under concurrent inserts | `analytics-aggregation.spec.ts` |
| Analytics period-day validation (round-3 R3-04) | `analytics-period-validation.spec.ts` |
| Organization onboarding: atomicity, idempotency, per-user serialization, slug collision | `organization-onboarding.spec.ts` |
| Negative-feedback alert abuse controls: server-owned cooldown, org-wide budget, real concurrency | `negative-feedback-alert-abuse.spec.ts` |
| Negative-feedback alert attempt/delivery status accounting | `negative-feedback-alert-finalize.spec.ts` |
| Card-editor location immutability at the UI/server-action/database layers | `nfc-card-location-lock.spec.ts` |
| Notification-email recipient confirmation flow, end-to-end including the real browser confirm-link round trip | `notification-email-verification.spec.ts` |
| RPC role-allowlist matrix (5+ functions × anon/authenticated/service_role), direct catalog introspection | `rpc-privilege-matrix.spec.ts` |
| Dashboard nav accessibility (accessible names, `aria-current`, keyboard) and responsive behavior at 320/375/768/desktop widths | `dashboard-nav-accessibility.spec.ts` |

**`rpc-privilege-matrix.spec.ts` and `location-deactivation-race.spec.ts` need a direct Postgres connection** (`SUPABASE_DB_URL`) — optional locally (skip gracefully without it), **mandatory in CI** as of round-4 R4-04 (`e2e/support/db-connection.ts` throws rather than skipping when CI is set and the connection is missing, invalid, or doesn't resolve to the approved isolated project). A skipped run of either is not equivalent to a passing one — check the run's own output for a `skipped` count, not just the absence of failures.

Runs locally against `npm run dev` (Playwright's `webServer` starts it automatically, isolated-project env injected — see `playwright.config.ts`) and in CI's `e2e` job (needs the four secrets in `DEPLOYMENT.md` § 4; skips the whole job, not individual tests, if any are missing).

## Review-Gating Regression Test (standing checklist)

Per the product skill, re-run this whenever the public rating/review flow changes:

- [ ] 1 star → Google Review CTA available, same placement/prominence as other ratings
- [ ] 2–5 stars → same
- [ ] No code path conditions CTA visibility on rating, sentiment, or AI analysis
- [ ] `features/feedback/schema.test.ts`'s `it.each([1,2,3,4,5])` still passes (schema-level guard)
- [ ] `e2e/review-gating.spec.ts` still passes (browser-level guard, automated in CI)

## CI

See `DEPLOYMENT.md` § 5 for the full job graph and gating model. In brief: `checks` (typecheck/lint/unit tests) → `e2e` (Playwright, needs all four secrets or skips) → `verify-production-deployment` (push to `master` only, confirms the live production `/api/health` reports the pushed commit — round-4 R4-01).

## Manual verification (this project's discipline, not a substitute for the above)

Whenever a change is only verifiable by actually using the app (a UI change, a flow that's awkward to script), it gets a real browser pass against the isolated test project before being called done — never against production, and never by asking the user to manually check something an automated test could instead cover permanently. See individual commit messages and `STATUS.md`'s round-by-round entries for what was manually verified when, rather than a separate manual checklist here that would just go stale the same way the old test counts did.

## Known gaps (tracked, not silently skipped)

- **No automated test that a real email is actually delivered via Resend.** The alert-cooldown/budget *claim mechanism* is tested directly (`negative-feedback-alert-abuse.spec.ts`, `negative-feedback-alert-finalize.spec.ts`); the isolated test project deliberately has no `RESEND_API_KEY` (`e2e/README.md`), so an actual Resend API call is never exercised by CI. Exercising it would need either a second, Resend-key-bearing test configuration or a mocked Resend client — not currently justified by risk (the claim/budget logic, which is where the actual abuse-prevention value is, is fully covered).
- **`verify-production-deployment` (round-4 R4-01) has not yet had a real failure to prove it actually catches the failure mode it's for** — it's designed and reasoned from the actual historical incident (`STATUS.md`), but its own alarm has not fired for real (by design, ideally never). Worth deliberately testing once, in a low-stakes way (e.g., temporarily pointing `PRODUCTION_HEALTH_URL` at a `--expected-sha` that will never match, on a non-`master` branch, to confirm the job actually goes red) rather than trusting the design alone forever.
