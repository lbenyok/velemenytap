# Review Request — Round 6

This is a response to a fifth-round independent review of PR #3, covering 13 new findings (R5-01 through R5-13) plus a re-assessment of every round-4 finding's actual fix quality. Read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, and `DEPLOYMENT.md`, all updated to reflect the current, post-round-5-fix state.

**Reviewed PR head (what round 5 reviewed):** `ddfb332`.
**Base:** `master` at `443ea98`.
**Branch:** `fix/round4-review-findings`, still based on `443ea98` — **not merged, no production changes of any kind.** One new migration exists this round (`20260905193325_server_owned_notification_email_change_budget.sql`); it has been applied only to the isolated Supabase test project, never to production, and is not part of this PR's rollout until reviewed and merged.
**Commit range (this round's fixes only):** `ddfb332..6febdc4` (10 commits, 27 files, +1719/-199).
**All 13 round-5 findings addressed.** Verdict: **all 13 confirmed, none rejected** — see § 1. The round-5 review's own "prior-finding verdict" table (re-assessing R4-01 through R4-08) is addressed in § 2.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R5-01 | `check-e2e-secrets` job only ever warned, never failed CI on a missing secret | **Confirmed** — reproduced by tracing the job's own logic; a missing secret on a trusted push/PR silently skipped the whole `e2e` job instead of failing | `89e43e6` |
| R5-02 | `projectRefFromDbUrl()` substring-matched the raw connection string instead of parsing it, so the approved ref could appear anywhere (query string, path, password) while actually connecting elsewhere | **Confirmed** — constructed the exact exploit string from the finding and confirmed it passed the old check | `4e76a25` |
| R5-03 – R5-04, R5-06 | `rollout.mjs` cluster: `--expand` had a silent empty default (a typo'd or forgotten migration name produced no error); `getPendingMigrations()` silently dropped unmapped migration versions via `.filter(Boolean)` instead of failing; `shell: true` was used for a command carrying an uncontrolled `--db-url` password, a command-injection surface — see note below | **Confirmed** (all three) | `0b4a63e` |
| R5-05 | `/api/health`'s environment check read `process.env.VERCEL_ENV` at runtime — the same variable Vercel's "expose system env vars" toggle suppresses, so that exact misconfiguration reported healthy | **Confirmed** — reproduced by unsetting `VERCEL_ENV` while asserting the build genuinely happened on Vercel via a mocked `BUILD_VERCEL_ENV`; the old logic passed, the new one fails loud | `1b32d27` |
| R5-07 | Dashboard nav and org name still collided at 1024px after the round-4 `lg` fix | **Confirmed** — measured directly against a real seeded dashboard: nav right edge 845.9px vs. org-name left edge 732.4px, a real overlap | `15780c1` |
| R5-08 | The homepage's blue-to-cyan gradient (clipped text and CTA background) fails WCAG contrast at its cyan end | **Confirmed** — computed via the exact relative-luminance formula: 3.72:1 down to 1.48:1 for the gradient text, 1.81:1 for solid white text over the background fill at the cyan end | `5a0da40` |
| R5-09 | `.public-feedback`'s CSS scope had no light-mode override for generic shadcn tokens, so a token read there could resolve to the dark-mode value inherited from `.dark` on `<html>` | **Confirmed** — reproduced via `getComputedStyle`: a submit button rendered `#5b8def` (dark accent) instead of `#2154eb` before the fix | `5a0da40` |
| R5-10 | The RPC privilege matrix never covered `request_notification_email_change`/`clear_notification_email`/`confirm_notification_email_change` despite docs claiming full coverage | **Confirmed** — grepped the matrix directly, confirmed the three were absent | `8b332d7` |
| R5-11 | Sentry redaction didn't sanitize `event.request.url` or breadcrumb URL fields, so a token/token_hash/code query param could reach Sentry intact; cookies and auth headers weren't stripped either | **Confirmed** | `37a908f` |
| R5-12 | `request_notification_email_change` had no rate limit, unlike the negative-feedback alert path — an org member could loop it to spam an arbitrary third-party inbox | **Confirmed** | `fde1fb7` |
| R5-13 | Several stale/inaccurate claims across `SECURITY.md`, `DATABASE_SCHEMA.md`, `DEPLOYMENT.md`, `e2e/README.md`, and two homepage copy overstatements | **Confirmed** | `5a0da40` (copy), `6febdc4` (docs) |

No finding was rejected.

**A note on the R5-03/R5-04/R5-06 row above:** this handoff was written after a context compaction partway through implementing the round-5 fixes, and the exact one-to-one mapping of which specific `rollout.mjs` sub-issue corresponds to which of R5-03/R5-04/R5-06 individually was not preserved verbatim from the original review text at that point — only that all three numbers belong to the same `rollout.mjs`-hardening cluster, and that the three sub-issues listed (the `--expand` default, the silently-dropped unmapped migration, and the `shell: true` injection surface) are the three real, distinct defects found and fixed in that file. If the exact per-number mapping matters for closing out this round precisely, please confirm it against the original round-5 review text — the fixes themselves do not depend on getting the mapping right, only this document's bookkeeping does.

## 2. Prior-finding (round 4) re-assessment — response

The round-5 review re-graded round 4's fixes as: R4-01 partially fixed, R4-02 still open, R4-03 not safely fixed, R4-04 not fixed, R4-05 fixed, R4-06 partially fixed, R4-07 partially fixed and copied into auth, R4-08 not fixed. Where this round's fixes address that re-grading directly:

- **R4-02** (GitHub branch protection / Vercel Deployment Checks) — **still open, and still cannot be closed from this repository.** No commit in this round claims otherwise. `DEPLOYMENT.md` § 5 continues to document the exact settings needed as an explicit, unconfigured owner action. This is the one item in the round-5 table this round does not claim to have resolved.
- **R4-03** (rollout script's judgment-call dependency) — the specific gaps the round-5 review found in the round-4 fix (`--expand` default, `.filter(Boolean)` swallowing unmapped versions, `shell: true`) are R5-03/R5-04/R5-06 above, all fixed in `0b4a63e`.
- **R4-04** (`SUPABASE_DB_URL` optional in CI) — the round-5 review's own re-grading concerned `check-e2e-secrets`'s enforcement, not the connection code itself; that job-level gap is R5-01, fixed in `89e43e6`.
- **R4-06** / **R4-07** (partial breakpoint/contrast fixes) — the specific residual gaps (1024px overlap; the homepage's own separate gradient instance, plus the auth page it was copied into) are R5-07/R5-08/R5-09 above.
- **R4-08** (stale documentation) — this round's own R5-13 findings are effectively a second, independently-discovered instance of the same problem; addressed the same way, in `6febdc4`.

## 3. What changed, structurally

- **The rollout script now validates its own inputs before touching the database** (`validateMigrationPlan()`) — every named migration must exist on disk, be genuinely pending, and every pending migration must be accounted for in one of `--expand`/`--enforce`; a typo or an unaccounted-for migration fails before any `supabase db push` runs.
- **`/api/health`'s environment signal is now a build-time fact, not a runtime one that a Vercel dashboard toggle can silently suppress** (`lib/build-info.ts`'s new `BUILD_VERCEL_ENV`).
- **A dual-control cooldown/budget pattern, already used for negative-feedback alerts, is now replicated for notification-email change requests** (`private.notification_email_change_log`, migration `20260905193325`) — this round's only new migration.
- **Sentry redaction now understands that a string value can be a URL carrying its own sensitive query parameters**, not just a key name to redact (`lib/sentry-redact.ts`'s new `sanitizeUrl()`).
- **The RPC privilege matrix now checks its own completeness against the live `pg_proc` catalog**, not just the entries someone remembered to list, closing the exact class of gap that let three functions go unchecked for two rounds.

## 4. Verification results (exact, fresh, this session)

```
npm run typecheck   tsc --noEmit           — clean
npm run lint         eslint                  — clean
npm run test           vitest run              — 162/162 passed (9 files)
npm ci && npm run build   next build (Turbopack) — clean, 19 routes, from a genuinely clean
                                                    node_modules (reproduces the reviewer's own
                                                    noted build-reproduction concern; it does not
                                                    reproduce here)
git diff --check                                — clean (only CRLF-normalization notices, not
                                                    real whitespace errors; exit code 0)
```

**Unit tests:** 162/162, up from the reviewer's own count of 102/102 — round 5 added `scripts/check-e2e-secrets.test.ts` (12), `scripts/rollout.test.ts` (20), 12 new adversarial cases in `e2e/support/db-connection.test.ts`, ~15 new cases in `lib/sentry-redact.test.ts`, and a rewritten `app/api/health/route.test.ts` covering the R5-05 regression scenario directly.

**e2e (Playwright), full suite, one shot, against the isolated test project:** `npx playwright test --list` confirms **99 tests across 16 spec files** (up from the reviewer's discovered 90/16 — round 5 added 4 tests to `notification-email-verification.spec.ts` and 3 to `rpc-privilege-matrix.spec.ts`). Running all 99 in one local invocation with default (parallel) workers: **86 passed, 13 failed**, every failure an `AuthApiError: Request rate limit reached` from Supabase's own Auth service (or a downstream symptom of it — two `redirect-safety` tests failed only because the sign-in step they depend on hit the same limit and the login page never navigated away). This is a real, observed result and is reported here rather than re-run until green and left unremarked.

**Root-cause check, not an assumption:** re-ran the four affected spec files (`notification-email-verification`, `redirect-safety`, `organization-onboarding`, `tenant-isolation`) together but in isolation from the other 12 files — **35/35 passed**, including every one of the 13 tests that failed in the full run. This confirms the failures are Supabase Auth rate-limit exhaustion from the sheer volume of sign-ins across all 16 files run back-to-back locally with parallel workers (`playwright.config.ts` defaults `workers` to the CPU count locally), not a logic regression from this round's changes. `playwright.config.ts` already runs CI with `workers: 1` (serial) and `retries: 1` — a materially gentler profile than this local full-suite run — but this has not been proven to never flake in CI, only reasoned about; see § 5.

**No test was silently skipped in either run** — `rpc-privilege-matrix.spec.ts` and `location-deactivation-race.spec.ts` (the two connection-requiring specs) both ran for real in both the full run and the isolated re-run, `SUPABASE_DB_URL` having been exported for the session.

### Non-regression check (per the task's explicit requirement)

Re-running the full suite exercises every named invariant directly: `tenant-isolation.spec.ts` (tenant isolation/RLS — passed in the isolated re-run), `rpc-privilege-matrix.spec.ts` (all ten RPCs' exact grants plus the new completeness check — freshly re-verified standalone, 11/11 passed), `notification-email-verification.spec.ts` (freshly re-verified in the isolated re-run, all 14 tests including the 4 new R5-12 ones passed), `lib/sentry-redact.test.ts` (part of the 162/162 unit-test run above), and `review-gating.spec.ts` (the Google Review non-gating invariant, all five ratings — passed in the full run). **Security invariants confirmed unchanged relative to `master`:** `git diff 443ea98..HEAD` was inspected before writing this section and contains no RLS policy changes, no changes to existing triggers, no changes to `submit_feedback_atomic`/`claim_negative_alert_send`/`finalize_negative_alert_send`, and no changes to `lib/sentry-redact.ts`'s pre-existing key-based `redactDeep` logic (R5-11 only adds to it). The one new migration this round (R5-12) adds a new table and two new functions; it does not alter any existing RLS-governed table or function.

## 5. Remaining risks / explicitly not addressed

- **GitHub branch protection and Vercel Deployment Checks are still not configured** (R4-02) — `DEPLOYMENT.md` § 5 documents exactly what's needed; this repository has no access to set either. This PR is **not merge-ready** on that basis alone, independent of code quality.
- **The full local e2e run's Auth rate-limit exhaustion (§ 4) has not been proven absent in CI.** CI's serial `workers: 1` + `retries: 1` profile is a materially different (gentler) load pattern than the local full-parallel run that triggered it, and every affected test passes in isolation, but this is reasoning from a different execution profile, not a CI run actually observed green under load. If CI shows the same `AuthApiError` pattern after this PR merges, the fix is almost certainly raising the isolated test project's Auth rate limit (Supabase dashboard → Authentication → Rate Limits) for that project specifically — never production's — an external configuration change this repository cannot make.
- **The new `private.notification_email_change_log` table and its two functions are untested against production** — by design; verification here is entirely against the isolated project, and the migration has not been applied to production.
- **`verify-production-deployment`'s R5-05 fix has not fired against a real Vercel deployment** — the regression test proves the logic handles the misconfiguration correctly in isolation (a mocked `BUILD_VERCEL_ENV` with `process.env.VERCEL_*` unset), but the actual Vercel build pipeline producing a correct `BUILD_VERCEL_ENV` at build time has not been observed firsthand, since this repository cannot trigger a real Vercel deployment.
- **Preview-environment Vercel variables remain unconfigured** (carried over from round 4) — documented in `DEPLOYMENT.md` § 3, not applied.

## 6. Rollout

**One new migration this round:** `20260905193325_server_owned_notification_email_change_budget.sql` (R5-12) — creates `private.notification_email_change_log` and replaces `request_notification_email_change`/adds `finalize_notification_email_change_send`. Applied only to the isolated test project so far. This is a normal additive migration (new table, new/replaced functions) with no data migration and no dependency on the expand/enforce staged-rollout mechanism `scripts/rollout.mjs` exists for — it can be applied directly once this PR is reviewed and merged, following the same manual `supabase db push` step every other migration in this project has used (`DATABASE_SCHEMA.md`'s own convention; there is no CI-driven migration step).

**Rollback plan:** every other change in this round is either a new, isolated file (`scripts/check-e2e-secrets.mjs`, `scripts/rollout.test.ts`, `scripts/check-e2e-secrets.test.ts`) or a scoped edit to existing files — reverting the commits in this PR fully reverts the round. The one migration is additive only (new table, new functions, no altered existing objects), so reverting the application-code commit that depends on it (`fde1fb7`) without reverting the migration itself leaves an unused table and two unused functions behind, harmlessly; fully reverting both is equally safe since nothing else references `private.notification_email_change_log`.

## 7. Where to be especially critical this round

1. **The Auth rate-limit finding in § 4/§ 5** — judge whether "reasoned about but not proven in CI" is sufficient given this PR's own new tests (R5-12's concurrency tests) are part of what pushed local full-suite volume over the limit; consider whether CI should be watched closely on the first real run after merge, or whether the isolated project's rate limit should be raised proactively before merging rather than reactively after a CI failure.
2. **`finalize_notification_email_change_send`'s `SECURITY DEFINER` ownership check** (`supabase/migrations/20260905193325_...sql`) — confirm the `auth.uid()` + membership check inside the function body is airtight, since this is a new public-facing `DEFINER` function and the whole point of the round-5 finding it fixes was a missing rate limit on a similarly-shaped function.
3. **`validateMigrationPlan()`'s coverage** (`scripts/rollout.mjs`) — confirm it actually catches every way a mismatched `--expand`/`--enforce` argument list could reach `supabase db push`, by reading the function directly rather than trusting the 20 new unit tests alone.
4. **Whether R4-02 remaining open, unchanged since round 4, should now block this PR outright** — two review rounds have confirmed the same gap; judge whether continuing to hand it off as documentation is still the right call.
5. **The `--pf-accent-gradient-text`/light-mode-token-pinning fix's completeness** (`app/globals.css`) — confirm no other CSS custom property inside `.public-feedback` still silently inherits a `.dark`-scoped value the way `--primary` did before this fix; the review is invited to grep for any variable used inside that scope that isn't in the newly-pinned list.
