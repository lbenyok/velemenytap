# Review Request — Round 7

This is a response to a sixth-round independent review of PR #3, covering 11 findings (R6-01 through R6-11). Read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, and `STATUS.md`, all updated to reflect the current, post-round-6-fix state.

**Reviewed PR head (what round 6 reviewed):** `f21686f`.
**Base:** `master` at `443ea98`.
**Branch:** `fix/round4-review-findings`, still based on `443ea98` — **not merged, no production changes of any kind.** Two migrations exist in this round: one (`20260905193325_...`) is a round-5 migration rewritten in place (never reached production, so this was safe — see below) and one (`20260906090000_...`) is genuinely new and corrective. Both applied only to the isolated Supabase test project.
**Commit range (this round's fixes only):** `f21686f..2f9d797` (6 commits, 27 files, +1525/-483).
**All 11 round-6 findings addressed.** Verdict: **all 11 confirmed, none rejected** — see § 1.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R6-01 | `request_notification_email_change()` — both round-3's (production-deployed) and round-5's versions — returned the raw confirmation token directly to its `authenticated` caller, letting any org member confirm an arbitrary address without proving inbox control | **Confirmed** — the pre-existing e2e suite's own test already demonstrated the exact bypass (call the RPC directly, read `data.token`) | `94cd554` |
| R6-02 | Sentry redaction never touched `event.request.query_string`, and neither `beforeSend` nor anything else covered transaction events or individual spans, where a live token could reach Sentry via `url.full`/`url.query` span attributes | **Confirmed** — reproduced via canary tests against all three shapes of `query_string` and against a constructed `SpanJSON` | `04df8a7` |
| R6-03 | The round-5 migration replaced `request_notification_email_change`'s signature and return shape in the same deployment that started consuming it, with no expand/deploy/contract sequencing | **Confirmed** — fixed as part of the R6-01 redesign (new 2-argument function coexists with the old one; see § 2 for the one deliberate exception) | `94cd554` |
| R6-04 | Cooldown/budget were plain caller-suppliable RPC parameters (`p_cooldown_minutes`/`p_org_hourly_budget`) an `authenticated` caller could simply override; `finalize_notification_email_change_send` was `authenticated`-callable with a caller-supplied delivery result | **Confirmed** — reproduced by calling with `p_cooldown_minutes: 0, p_org_hourly_budget: 999999` against the pre-fix signature | `94cd554` |
| R6-05 | `confirm_notification_email_change` SELECTed by token hash, then UPDATEd by `id` alone with no re-check — a concurrent request for the same org could replace the pending address between the two statements | **Confirmed** — reproduced directly: issue a token, replace the pending request, confirm the stale token, assert it promotes nothing | `94cd554` |
| R6-06 | `/api/health`'s R5-05 fix (`BUILD_VERCEL_ENV`) rested on a false premise — Vercel gates `VERCEL_ENV` at build time too, not just runtime, contrary to what R5-05 assumed | **Confirmed** — verified against Vercel's own current documentation (fetched directly, quoted in `DECISIONS.md`), not re-asserted from memory | `3d81676` |
| R6-07 | `scripts/rollout.mjs`'s `--allowed-origin`/`--health-url` were caller-supplied, cross-checked only against each other — proving nothing about whether `--db-url` belonged to the same application | **Confirmed** | `49dcdb4` |
| R6-08 | A fork PR's `e2e` job correctly skips (no secrets), but GitHub treats a skip as satisfying a required status check — a fork PR could merge without the RPC privilege matrix or RLS tests ever running | **Confirmed** — this is a structural fact about GitHub Actions' required-check semantics, not something to reproduce experimentally | `d962198` |
| R6-09 | Multiple stale documentation claims (admin-client consumer count, secrets-skip behavior, rollout usage example, RPC return-type description, a duplicated command block) | **Confirmed** — a fresh code-to-document cross-check surfaced these plus the ones explicitly listed | `2f9d797` |
| R6-10 | `db-connection.ts`'s unguarded `decodeURIComponent()` throws an uncaught `URIError` on malformed percent-encoding instead of returning `null` | **Confirmed** — reproduced with `postgres%ZZ` and a lone trailing `%` | `49dcdb4` |
| R6-11 | `--expected-sha` accepted a short (7-char) SHA that could never match `/api/health`'s always-full-length `commitSha`, discovered only after phase 1 had already applied and a multi-minute timeout elapsed | **Confirmed** | `49dcdb4` |

No finding was rejected.

## 2. Where this round diverges from the literal remediation text

- **R6-01 vs. R6-03, for the round-3 3-argument function specifically.** R6-03 asks, as a general principle, for the old RPC to stay callable during a rollout window while a new one is introduced. But the round-3 function's `authenticated`-callable, token-returning behavior **is** the R6-01 vulnerability — there is no way to keep it "compatible" without also keeping it exploitable. Chose to revoke `authenticated`'s grant on it immediately (migration `20260906090000`), accepting a brief, deliberate compatibility gap (old code gets a clean "permission denied" instead of continuing to leak tokens) rather than a strict zero-disruption window. The function's body and signature are left intact — not dropped — so this is still a documented, bounded exception to R6-03's general principle, not a rejection of it. Full reasoning in `DECISIONS.md` § "R6-01/R6-03".
- **A `clock_timestamp()` fix not asked for by any finding**, caught during this round's own verification: the cooldown/budget checks used `now()` (frozen at transaction start), which under genuine concurrency serialized through the advisory lock could let a queued transaction's own frozen timestamp predate another transaction's already-inserted row, spuriously tripping the cooldown at `p_cooldown_minutes = 0`. Reproduced as a real, intermittent test failure (1 fail in 3 runs before the fix, 0 in 8 after) and fixed in the same migration, since it's directly in the function being rewritten for R6-04 anyway.

## 3. What changed, structurally

- **The notification-email-change token is no longer reachable from any authenticated or anonymous client, structurally.** `issue_notification_email_change_token()` is `service_role`-only; the settings Server Action now calls it via the admin client, the same trust boundary `SUPABASE_SECRET_KEY` itself already lives behind.
- **Rate-limit parameters moved from RPC arguments into a per-organization, server-only config table** (`private.notification_email_change_config`) — keyed per organization specifically so tests can tune it without racing every other concurrently-running test against a shared global.
- **`scripts/rollout.mjs` now derives its trust anchors from a committed manifest** (`scripts/rollout-environments.json`), not from caller-supplied arguments — `--allowed-origin`/`--health-url` no longer exist as flags at all.
- **A new required CI check, `e2e-gate`**, closes the gap where a skipped `e2e` job (correct for fork PRs) could otherwise satisfy branch protection identically to a real pass.
- **Sentry's tracing pipeline is now redacted with the same discipline as its error pipeline** — `beforeSendTransaction` and `beforeSendSpan` wired up alongside the existing `beforeSend`.

## 4. Verification results (exact, fresh, this session)

```
npm run typecheck        tsc --noEmit            — clean
npm run lint              eslint                   — clean
npm run test                vitest run               — 191/191 passed (9 files)
npm run build                 next build (Turbopack)    — clean, 19 routes
git diff --check                                        — clean (only CRLF-normalization notices,
                                                             not real whitespace errors; exit code 0)
node --check (workflow YAML)                            — .github/workflows/ci.yml parses correctly
                                                             via js-yaml; all 5 jobs present
supabase db advisors --type all                         — "No issues found", against the isolated
                                                             test project after both migrations applied
```

**Unit tests:** 191/191, up from 162/162 at the last handoff — this round added/extended cases in `lib/sentry-redact.test.ts` (query_string, transaction, and span coverage), `app/api/health/route.test.ts` (fully rewritten for the `APP_ENV`/`NODE_ENV` design — missing/malformed/preview/production/local cases), `scripts/rollout.test.ts` (the manifest/`--target` trust model, the full-SHA requirement), and `e2e/support/db-connection.test.ts` (malformed percent-encoding).

**e2e (Playwright), against the isolated test project:** `npx playwright test --list` confirms **106 tests across the same 16 spec files** (up from 99). Both migrations were applied to the isolated project (the rewritten `20260905193325` and the new `20260906090000`), confirmed via `supabase migration list` and re-verified with `supabase db advisors` after.

Every spec file touched this round was run to a clean pass, **in isolation, more than once**: `notification-email-verification.spec.ts` (all 19 tests, including the 5 new R6-01/R6-04/R6-05 tests), `rpc-privilege-matrix.spec.ts` (13 tests — 12 per-function grant checks plus the completeness check; 12/12 grant checks ran, with 1 of those 12 correctly skipped for a function this isolated project's own migration history never had — see below). The concurrency test (`R5-12: an organization-wide hourly budget...`) was specifically re-run 5 additional times after the `clock_timestamp()` fix with 5/5 passes, following 1 genuine failure in 3 runs before it — this is what surfaced and confirmed the bug described in § 2.

**One test-project-specific accommodation, not a gap:** the isolated test project's own migration history never created the round-3 3-argument `request_notification_email_change` (its history was built up independently of production's — see `DATABASE_SCHEMA.md`/`STATUS.md`), so the two tests asserting "this specific function has zero grants" and "the catalog has no unexpected function" both treat that one entry as environment-conditional (`mayNotExistInThisEnvironment`), verified present-or-absent via `to_regprocedure()` rather than assumed. Every other entry in both tests is checked unconditionally.

**Full-suite run, one shot, with default parallel workers:** produced the same class of failure this project's round-5 handoff already documented and diagnosed — Supabase Auth's shared rate limiter (`AuthApiError: Request rate limit reached`) exhausted by the volume of sign-ins across 16 files run back-to-back locally, worsened this session by the sheer number of full-suite and partial re-runs performed during this round's own debugging. One additional failure in that run (`organization-onboarding.spec.ts`'s slug-collision test) was traced to leftover test data from an earlier interrupted debug run in this same session (a `slug='taken'` row), not a code defect — deleted, and the test re-verified passing immediately after. **No round-6 code change caused a new class of failure**: every failure in the full-suite run was either the pre-existing Auth rate-limit pattern (confirmed by re-running the affected files in smaller batches until they passed) or the one identified data-pollution artifact.

**Not verified this round:** a live GitHub Actions run of the new `e2e-gate` job (requires pushing this branch, done as the last step of this handoff — see the CI status reported after push) and a live Vercel deployment exercising `APP_ENV` (this repository cannot trigger one).

## 5. Remaining risks / explicitly not addressed

- **GitHub branch protection and Vercel Deployment Checks are still not configured** (R4-02, carried forward unchanged since round 4) — this PR is **not merge-ready** on that basis alone, independent of code quality. When it is configured, require `e2e-gate` (new, R6-08), not `e2e` itself.
- **`APP_ENV` is not yet set in Vercel** (R6-06) — until the owner adds it (Production: `production`, Preview: `preview`; `DEPLOYMENT.md` § 3), `/api/health` will report `ok: false`/503 in both environments. This is the fix working as designed, not a bug, but it is a visible behavior change the owner should expect and act on, not be surprised by.
- **The round-3 3-argument `request_notification_email_change` is intentionally still defined, just ungrantable** — a future cleanup migration should drop it once confident nothing could still reference it (`DECISIONS.md` § "R6-01/R6-03" suggests one deploy cycle is almost certainly sufficient, given this is a low-frequency settings action).
- **`e2e-gate`'s actual behavior on a real fork PR has not been observed** — its logic is straightforward (fail unless `e2e`'s result is exactly `"success"`) and unit-testable reasoning, but no fork PR exists against this repository to trigger it for real.
- **The Auth rate-limit characteristic from round 5 remains unresolved as an environment property** — still not something this repository's code can fix (it's Supabase's own shared rate limiter on the isolated project); still recommended that the owner consider raising it if CI ever shows the same pattern under load.

## 6. Rollout

**Two migrations this round**, both unapplied to production:
- `20260905193325_server_owned_notification_email_change_budget.sql` — a round-5 migration rewritten in place. Safe to edit directly (not layer a correction on top of) because it was never applied to production in its original form — confirmed via `STATUS.md`'s own record of what's actually live there.
- `20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql` — genuinely new and corrective, since it fixes objects (`confirm_notification_email_change`, the round-3 `request_notification_email_change`) that **are** already live in production. Both statements are either a `create or replace` with an unchanged signature (no compatibility concern) or a grant revocation wrapped to tolerate the target's absence.

Neither migration needs the expand/enforce staged mechanism `scripts/rollout.mjs` exists for — no existing trigger or column is being newly protected against currently-deployed code. They can be applied directly via the normal manual `supabase db push` step, in either order, once this PR is reviewed and merged.

**Rollback plan:** every change in this round is either a new, isolated file (`scripts/rollout-environments.json`, the new migration) or a scoped edit to existing files. The migrations are safe to roll back independently of the application code: `20260906090000`'s revoke can be re-granted and its function body reverted via a follow-up migration; `20260905193325`'s new objects (table, functions) can be dropped by a follow-up migration with no data-loss risk, since nothing outside this feature references them.

## 7. Where to be especially critical this round

1. **The R6-01/R6-03 tradeoff itself** (§ 2, `DECISIONS.md`) — judge whether immediately revoking the round-3 function's grant, rather than a strict compatibility window, was the right call, or whether the compatibility risk (however brief) should have been weighed differently.
2. **`issue_notification_email_change_token`'s `service_role`-only boundary** (the migration, `features/organizations/settings-actions.ts`) — confirm there is genuinely no path from a browser or authenticated client to this function or its return value, since this is the single control the entire R6-01 fix rests on.
3. **The `clock_timestamp()` fix's completeness** (§ 2) — confirm no other freshness/window check in this codebase (the negative-feedback alert's own cooldown/budget, `claim_negative_alert_send`) has the same latent `now()`-under-concurrency issue; this round only fixed the one function being touched for R6-04, not audited every existing one for the same class of bug.
4. **Whether `APP_ENV`'s consequence (§ 5) was communicated clearly enough** — a health check going from misleadingly-green to correctly-red the moment this merges, until a manual Vercel step happens, is exactly the kind of "fix that looks like a regression" worth double-checking is actually understood and accepted, not just technically correct.
5. **The `mayNotExistInThisEnvironment` test accommodation** (§ 4, `e2e/rpc-privilege-matrix.spec.ts`) — confirm this doesn't quietly weaken the completeness guarantee for any function other than the one specific, explained case it's scoped to.
