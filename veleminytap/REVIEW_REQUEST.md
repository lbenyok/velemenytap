# Review Request — Round 8

This is a response to a seventh-round independent review of PR #3, covering 8 findings (R7-01 through R7-08), plus additional defects found during this round's own reproduction work and its own independent adversarial self-review of the final diff. Read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, and `STATUS.md`, all updated to reflect the current, post-round-7-fix state.

**Reviewed PR head (what round 7 reviewed):** `799974d`.
**Base:** `master` at `443ea98`.
**Branch:** `fix/round4-review-findings` — **not merged, no production changes of any kind.**
**This round's commit range:** `799974d..5010847` (8 commits, 26 files, +1638/-165).
**Four new migrations this round**, all applied only to the isolated Supabase test project, never production: `20260906100000` (drops the round-3 3-argument `request_notification_email_change` overload outright), `20260906110000` (fixes `claim_negative_alert_send`'s `now()`-under-concurrency bug), `20260906120000` (fixes the identical bug in `request_notification_email_change` itself, found by this round's own self-review, not the original 8 findings).
**All 8 round-7 findings addressed, plus 5 additional defects found during this round's own work.** Verdict: **all 8 confirmed, none rejected** — see § 1. The 5 additional defects are in § 2.

**Read this section before any other claim in this document**: every fix described below was implemented, then verified against the isolated Supabase test project, then **committed to git** (`git log 799974d..HEAD`) before this document was written — a genuine gap in an earlier draft of this round's own work (an independent review agent pointed out, correctly, that the fixes existed only in an uncommitted working tree at that point, while `STATUS.md`/`SECURITY.md` already claimed them "implemented and tested"). That gap is now closed: `git diff --check` was re-run against the actual committed range, not the working tree, and the commit SHAs cited throughout this document are real, pushed commits — reproduce with `git show <sha>`.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R7-01 | `redactSpan` missed `http.target` (a real OpenTelemetry attribute the installed SDK attaches to HTTP spans, carrying the full raw pathname+query); `sendDefaultPii: false` was never actually equivalent to disabling URL/query collection | **Confirmed** — reproduced `http.target` leaking a canary unchanged before the fix, via direct SDK-shaped span construction | `7b56332` |
| R7-02 | `scripts/rollout.mjs`'s `execFileSync()` failure path discloses the production database password via `Error.message`/`.stdout`/`.stderr`, even though the happy-path log line redacts it | **Confirmed** — reproduced with a canary embedded in `--db-url`, appearing unredacted in the thrown error before the fix | `cc3181c` |
| R7-03 | The isolated test DB's migration bookkeeping claimed the round-3 3-argument `request_notification_email_change` was applied when it didn't actually exist there; `rpc-privilege-matrix.spec.ts` silently skipped verifying it | **Confirmed**, and repairing it surfaced a second, more serious, previously-undiscovered bug (§ 2) | `6efc799` |
| R7-04 | `scripts/rollout.mjs`'s `allowedOrigin` manifest field is recorded but never cross-checked against `healthUrl`; `fetch()` follows redirects by default | **Confirmed** — reproduced with real local HTTP servers demonstrating an off-origin redirect being followed before the fix | `cc3181c` |
| R7-05 | `claim_negative_alert_send()` uses `now()` (frozen at transaction start) for cooldown/budget checks evaluated *after* acquiring an advisory lock — the same class of bug round 6 (R6-04) fixed elsewhere | **Confirmed** — reproduced as an intermittent real concurrency-test failure before the fix, 5/5 stable after | `9166e5c` |
| R7-06 | After `request_notification_email_change()` creates a reservation, a failure in `issue_notification_email_change_token()` returns immediately without finalizing it, stranding budget | **Confirmed** — reproduced by forcing token issuance to fail against an already-resolved reservation (VT205) and observing the budget slot stay consumed before the fix | `3d37370` |
| R7-07 | `/api/health` treats any `NODE_ENV` other than `"production"` as local development (fail-open) — unset, malformed, or `"test"` all reported healthy development | **Confirmed** — reproduced directly: `NODE_ENV=test` (Vitest's own default) returned `ok:true` with no `APP_ENV` check before the fix | `ea9e3fb` |
| R7-08 | Multiple documentation inaccuracies (grant descriptions, RPC counts, a rollout example listing already-applied migrations, a genuine rollout-ordering mistake in round 6's own handoff) | **Confirmed** — a fresh code-to-document cross-check surfaced these plus the ones explicitly listed, and one additional real (not just stale-documentation) rollout-ordering defect — see § 2 | `5010847` |

No finding was rejected.

## 2. Defects found beyond the 8 named findings

None of these were in the review's original list. Each was found during this round's own reproduction work or its own independent adversarial self-review of the complete diff (a separate agent instance, given no access to this session's implementation reasoning, tasked with attacking the final diff cold) — the review's own explicit instruction to perform this pass, followed literally, is what surfaced them.

1. **A `PGRST203` overload-ambiguity bug, found while fixing R7-03 (HIGH-severity in practice).** Recreating the round-3 3-argument `request_notification_email_change` to genuinely match production (closing R7-03's drift) immediately broke *every* call to `request_notification_email_change` — old and new application code alike — with `PGRST203: "Could not choose the best candidate function"`. PostgREST's overload resolution is ambiguous between a 2-argument call and this function (whose third parameter has a `default`, making it satisfiable with 2 arguments) **independent of grants** — round 6's grant-revocation-only fix (migration `20260906090000`) never actually resolved this. Fixed by dropping the function outright (migration `20260906100000`). This is not merely a documentation correction: it also means migration `20260906090000` (round 6) and the new `20260906100000` both require this PR's new application code to be deployed *first*, since production's currently-live code still calls the 3-argument signature — round 6's own handoff had incorrectly claimed neither needed staged rollout. `DATABASE_SCHEMA.md`/`DEPLOYMENT.md` now classify both as `--enforce`. Commit `6efc799` (drop), `5010847` (docs correction).
2. **A third instance of the R7-05 `now()`-under-concurrency bug, in the very function R6-04 had already partially fixed.** `request_notification_email_change()`'s cooldown/budget *checks* correctly used `clock_timestamp()`, but the reservation row it inserts right after relied on `reserved_at`'s `now()`-based column default. This round's own initial "search the whole schema for this pattern" pass (done for R7-05) missed it, because it modeled the pattern as "a check after a lock," not "any timestamp-producing statement after a lock, checks and writes alike." Found only by the independent self-review pass. Fixed in migration `20260906120000`. Verified with a genuine two-connection concurrency test — a raw connection holds the identical advisory lock for a fixed window, forcing the RPC to queue behind it — confirmed to **fail against the pre-fix function body and pass against the fix**, both checked directly against the isolated project before considering this closed. Commit `9166e5c`.
3. **`scripts/rollout.mjs`'s `getPendingMigrations()` had an unsanitized error path bypassing R7-02's fix entirely.** On a successful (zero-exit) `supabase migration list` call whose stdout doesn't contain a `{`, it threw its own error embedding the raw stdout directly — not an `execFileSync` failure, so `sanitizeSubprocessError` never ran. No current CLI version leaks a credential this way, so this wasn't an active exploit, but it defeated R7-02's entire point for this one specific path. Fixed by redacting defensively. Commit `cc3181c`.
4. **Sentry's `event.exception` (the captured error message text) was never redacted by any hook.** No current code path in this app embeds a token/URL in a thrown `Error`'s message, so this wasn't an active leak, but it's a structural gap in exactly the redaction layer R7-01 was about — a future `throw new Error(\`failed for ${url}\`)` anywhere in the app would have shipped a live token to Sentry with no protection in its way. Fixed by running each exception value's message through the same URL/JSON-string sanitization `extra`/`contexts`/`transaction` already get. Commit `7b56332`.
5. **Two `console.error` calls logged whole Resend SDK error objects verbatim; one e2e test only cleaned up its own seeded data on the happy path.** Both low-severity, neither a demonstrated leak (Resend's documented error shape doesn't echo submitted content) nor security-relevant (a test-hygiene gap, not a security test), but both cheap to fix and directly encountered during this round's own verification runs (the leftover-data issue broke re-runs of `organization-onboarding.spec.ts` twice this session). Commit `3d76021`.

## 3. What changed, structurally

- **Sentry's span/exception redaction now covers every URL/query-carrying field this SDK version actually has**, not just the ones the original R6-02 fix anticipated — `http.target`, `url.original`, and `event.exception` are new; `dataCollection` replaces the deprecated, less-complete `sendDefaultPii` toggle in every runtime config.
- **`scripts/rollout.mjs`'s trust model is now enforced end-to-end**, not just recorded: `allowedOrigin`/`healthUrl` must genuinely share an origin, `pollHealth` never follows a redirect, and every subprocess failure — including one specific path that previously bypassed the wrapper — is credential-redacted before it can reach a log.
- **The notification-email-change RPC surface is down to exactly the one signature the application ever calls.** The round-3 3-argument overload — kept "for compatibility" since round 6 — turned out to make the *replacement* signature unreliable for every caller the moment both existed; it's now dropped outright, and the production rollout plan is corrected to sequence that drop after the application-code deploy it actually depends on.
- **Every lock-then-timestamp function in this schema now consistently uses one captured `clock_timestamp()` value** — three total instances of this bug class were found and fixed across this round (one named finding, two found during this round's own verification and self-review), a higher hit rate than the "search once, done" approach from round 6 assumed.

## 4. Verification results (exact, fresh, this session)

```
npm ci                                                  — clean, 0 vulnerabilities
npm run typecheck        tsc --noEmit                   — clean
npm run lint              eslint                        — clean
npm run test                vitest run                  — 236/236 passed (9 files), 0 skipped
npm run build                 next build (Turbopack)    — clean, 19 routes
git diff --check 443ea98..HEAD                          — clean (only CRLF-normalization notices,
                                                             not real whitespace errors; exit code 0)
node -e (workflow YAML via js-yaml)                     — .github/workflows/ci.yml parses correctly;
                                                             all 5 jobs present (checks, check-e2e-secrets,
                                                             e2e, e2e-gate, verify-production-deployment)
supabase migration list --db-url <isolated project>     — all 22 migrations local==remote, no drift
supabase db advisors --type all                         — "No issues found", re-checked after every
                                                             schema-affecting change this round
```

**Unit tests:** 236/236, up from 191/191 at the last handoff — added/extended: `lib/sentry-redact.test.ts` (`http.target`, `url.original`, `event.exception` — 6 new tests including one for a chained/multi-value exception), `app/api/health/route.test.ts` (fully rewritten NODE_ENV matrix — development/production/test/missing/malformed, each crossed with valid/missing APP_ENV and commit SHA — 15 tests), `scripts/rollout.test.ts` (subprocess-credential redaction end-to-end, real local-HTTP-server redirect rejection, the manifest origin-match enforcement, the `getPendingMigrations` defensive-redaction regression — 61+ tests including 5 real-server redirect tests each taking ≥5s by design).

**e2e (Playwright), against the isolated test project:** `npx playwright test --list` confirms **108 tests across the same 16 spec files** (up from 106). Every one of the 4 new migrations was applied and confirmed via `supabase migration list` (local==remote) and `supabase db advisors` (clean) after each.

**Full-suite run**: a parallel run (`--workers=3`) produced 100 passed / 8 failed, every failure `AuthApiError: Request rate limit reached` from Supabase Auth's shared rate limiter on the isolated project — the same pre-existing, already-documented (round 5/6 handoffs) environment characteristic, not a code defect. Re-running the two affected files (`notification-email-verification.spec.ts`, `organization-onboarding.spec.ts`) serially (`--workers=1`) confirmed **all 8 pass** — combined: **108/108, zero unexplained failures, zero skips.** One of those 8 (`organization-onboarding.spec.ts`'s slug-collision test) additionally hit a real, if minor, test-hygiene gap (leftover seed data from an earlier interrupted run, since that test only cleaned up on its happy path) — fixed with `try`/`finally` (commit `3d76021`) and re-confirmed passing after.

**Targeted concurrency tests, run repeatedly (not once):** the R7-05 `claim_negative_alert_send` zero-cooldown concurrency test — 3/3 runs, all 6 tests in its file passing each time (18/18 total). The new R7-05-class `request_notification_email_change` `reserved_at` regression test — 3/3 runs passing. That same test was also **confirmed to fail for the actual reason described**: temporarily reverted the fixed function to its pre-fix body directly against the isolated project, re-ran the test, watched it fail with exactly the predicted `reserved_at`-too-early symptom, then restored the fix from the exact committed migration file and re-confirmed passing — the discipline this task's own instructions require, not skipped for this one.

**Targeted Sentry canary tests:** all `lib/sentry-redact.test.ts` tests pass, including the `http.target` reproduction (the literal finding), the comprehensive "realistic incoming HTTP server span" test asserting every field at once, and the new `event.exception` tests.

**Targeted rollout failure/redirection tests:** all `scripts/rollout.test.ts` tests pass, including 5 tests against real local `node:http` servers (same-origin success, off-origin redirect, same-origin redirect, redirect loop, HTTP downgrade — each rejected) and the subprocess-credential-redaction tests for both `supabase migration list` and `supabase db push` failure paths.

**Live GitHub Actions run for this exact commit (`5010847`):** [run #34033618052](https://github.com/lbenyok/velemenytap/actions/runs/34033618052) — completed, all applicable jobs **succeeded**:

| Job | Result | Link |
|---|---|---|
| `check-e2e-secrets` | success | [job](https://github.com/lbenyok/velemenytap/actions/runs/34033618052/job/101487596837) |
| `checks` (typecheck, lint, unit tests) | success | [job](https://github.com/lbenyok/velemenytap/actions/runs/34033618052/job/101487596994) |
| `e2e` (Playwright, review-gating regression) | success, 5m51s | [job](https://github.com/lbenyok/velemenytap/actions/runs/34033618052/job/101487754326) |
| `e2e-gate` ("E2E actually ran (required check)") | success | [job](https://github.com/lbenyok/velemenytap/actions/runs/34033618052/job/101488532838) |
| `verify-production-deployment` | **skipped** | [job](https://github.com/lbenyok/velemenytap/actions/runs/34033618052/job/101488533332) |

The `verify-production-deployment` skip is expected and correct, not a gap: that job's own `if:` condition restricts it to pushes to `master` (`DEPLOYMENT.md` § 5) — this run is against the feature branch, so it has nothing to verify yet.

**Could not be independently verified**: the exact per-test pass/fail/skip breakdown Playwright's own reporter printed inside the `e2e` job's log — GitHub's step-level log view for this run requires signing in to view (attempted via browser, blocked by a "Sign in to view logs" wall this session has no credentials for), and the REST API's log-download endpoint returned `403 Must have admin rights to Repository`. Only the job's overall pass/fail result and duration are independently confirmed from the CI run itself. The exact test counts reported in this section (236 unit / 108 e2e) come from running the identical suite locally against the same isolated Supabase test project CI itself uses (`e2e/support/env.ts`'s allowlisted project ref), not from parsing the CI log — a reviewer with repository access should confirm the CI job's own printed count matches.

**Not verified this round:** a live Vercel deployment exercising `APP_ENV` (this repository cannot trigger one).

## 5. Remaining risks / explicitly not addressed

- **GitHub branch protection and Vercel Deployment Checks are still not configured** (R4-02, carried forward unchanged since round 4) — this PR is **not merge-ready** on that basis alone, independent of code quality. When configured, require `e2e-gate` (round 6, R6-08), not `e2e` itself.
- **`APP_ENV` is not yet set in Vercel** (R6-06, carried forward) — until the owner adds it (Production: `production`, Preview: `preview`; `DEPLOYMENT.md` § 3), `/api/health` will report `ok: false`/503 in both environments. Round 7's own R7-07 fix makes this *more* consequential, not less: `NODE_ENV` values that used to fail open (an unset or malformed one) now also require `APP_ENV` to be established, closing a gap but making the unconfigured-`APP_ENV` state visible in more scenarios than before.
- **This round's own corrected finding about migrations `20260906090000`/`20260906100000` needing staged rollout is itself unverified against a real deployment** — the reasoning is sound and documented (`DATABASE_SCHEMA.md` § "Rollout ordering"), and `scripts/rollout.mjs`'s `--expand`/`--enforce` split is the intended mechanism, but no actual production rollout has exercised this corrected sequence yet, since nothing in this round has been applied to production.
- **The `now()`-after-lock class of bug has now been found three separate times across two rounds** (R6-04, R7-05, and this round's own self-review) — each search pass that "closed" it missed at least one instance the next pass found. Treat any future claim that this class is "fully audited" with the same skepticism this document is asking the reviewer to apply generally; a fourth pass by a reviewer with fresh eyes is worth doing, not assumed unnecessary.
- **The Auth rate-limit characteristic from round 5 remains unresolved as an environment property** — not something this repository's code can fix; still recommended the owner consider raising it if CI ever shows the same pattern under real load.

## 6. Rollout (corrected this round — see § 2, defect 1)

**Not yet applied to production, in dependency order:**

1. **Safe to apply before this PR's application code deploys** (`--expand`):
   - `20260905193325_server_owned_notification_email_change_budget.sql` — purely additive (new tables, new functions); never applied to production in any form.
   - `20260906110000_fix_claim_negative_alert_send_clock_timestamp.sql` — `create or replace` with an unchanged signature; safe drop-in.
   - `20260906120000_fix_request_notification_email_change_reserved_at_clock_timestamp.sql` — same, safe drop-in.
2. **Deploy this PR's application code** (calls the 2-argument `request_notification_email_change`, never the 3-argument one).
3. **Let old serverless instances drain.**
4. **Only then apply** (`--enforce`):
   - `20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql` — revokes the 3-argument function's grant (bundled with an unrelated, independently-safe `confirm_notification_email_change` TOCTOU fix).
   - `20260906100000_drop_ambiguous_request_notification_email_change_overload.sql` — drops the 3-argument function outright.

Corrected `scripts/rollout.mjs` invocation (see `DEPLOYMENT.md` § 7 for the full explanation):

```bash
node scripts/rollout.mjs \
  --target production \
  --db-url "$PRODUCTION_DB_URL" \
  --expand 20260905193325_server_owned_notification_email_change_budget.sql,20260906110000_fix_claim_negative_alert_send_clock_timestamp.sql,20260906120000_fix_request_notification_email_change_reserved_at_clock_timestamp.sql \
  --enforce 20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql,20260906100000_drop_ambiguous_request_notification_email_change_overload.sql \
  --expected-sha "$(git rev-parse HEAD)"
```

**Why this differs from round 6's own handoff**: round 6 claimed `20260906090000` needed no staged rollout, reasoning only about the vulnerability the migration closes, not about whether production's *currently-deployed* code still depends on the function it revokes access to. It does. See § 2, defect 1, and `DECISIONS.md` § "R7-03" for the full correction.

**Rollback plan:** every change in this round is either a new, isolated migration file or a scoped edit to an existing one. `20260906100000`'s drop can be reverted by a follow-up migration recreating the function from the round-3 migration's original body (though doing so would reintroduce the `PGRST203` ambiguity — reverting this specific migration is not actually recommended; if the new application code needs to roll back, roll back the application code, not this migration). `20260906110000`/`20260906120000`'s `clock_timestamp()` fixes can be reverted to their prior bodies with no data-loss risk, since neither changes a signature or drops anything.

## 7. Where to be especially critical this round

1. **The `PGRST203` discovery and its rollout-ordering consequence** (§ 2, defect 1) — confirm the corrected `--expand`/`--enforce` classification in § 6 is actually right, not just differently wrong from round 6's version. This is the highest-stakes correction in this round: getting it wrong in either direction either re-creates the exact incident `DEPLOYMENT.md`'s own opening section describes, or unnecessarily delays a fix for a real bug.
2. **Whether the third `clock_timestamp()` instance (§ 2, defect 2) is genuinely the last one** — two search passes each missed at least one real instance; a fourth, independent pass specifically for this pattern (lock acquisition anywhere in `supabase/migrations/*.sql`, followed by *any* statement — read or write — using `now()`/`clock_timestamp()`) is worth doing rather than trusting this round's own claim of completeness.
3. **The independent adversarial self-review's own findings (§ 2, defects 3-5)** — confirm each was actually fixed as described, not just plausibly addressed; the self-review agent had no access to this session's reasoning, which is exactly why it caught things the primary implementation missed, and a subsequent reviewer starting equally fresh is likely to be similarly effective.
4. **The git-history gap this document opens by acknowledging** (the note at the top of this document) — confirm there is no other place in this round's own process where "documented as done" and "actually committed" diverged, beyond the one instance already caught and corrected.
5. **Whether `APP_ENV`'s consequence (§ 5) has grown, not shrunk, as a result of R7-07** — confirm this is communicated clearly enough that the owner understands more deployment scenarios now depend on it being set, not fewer.
