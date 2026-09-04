# Review Request — Round 4

This is a response to a third-round independent review — this time of [PR #2](https://github.com/lbenyok/velemenytap/pull/2) itself (the round-2 fix branch), not of `master` — read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, and `DECISIONS.md`, all updated to reflect the current, post-round-3-fix state. If you're a different reviewer picking this up cold: those five documents are still the right starting point, in that order; this document is the delta since round 3's review, not a replacement for them.

**Reviewed state:** PR #2, branch `fix/round2-review-findings`, at commit `68cd929` (round 2's final commit, including its own documentation pass).
**Branch:** still `fix/round2-review-findings` — **not merged, not deployed, no production migration applied**, per this task's explicit constraint. Everything below was validated against the same isolated Supabase test project rounds 1–2 established (`.env.test.local`, gitignored), never against production.
**Commit range:** `68cd929..5787fd2` (5 commits, 23 files, +1727/-174).
**All 7 round-3 findings addressed** — verified independently against actual code/database/CI-failure-mode state first (reproduced the CI break R3-01 predicted, reproduced R3-02's race with real concurrent requests, confirmed R3-04/R3-07's gaps with direct RPC calls and catalog introspection), then fixed where confirmed. Verdict: **all 7 confirmed, no findings rejected**. See § 1 for the finding-by-finding detail.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R3-01 | `e2e/support/env.ts`'s per-key presence check could pass while still returning an object missing every required key — exactly what happens in CI (credentials only in `process.env`, no `.env.test.local` file), breaking Playwright's `globalSetup` before any test runs | **Confirmed** — reproduced the exact CI failure mode locally by simulating the CI env shape | `a2e75eb` |
| R3-02 | `claim_negative_alert_send`'s org-wide budget check had no lock scoped to the organization; concurrent claims for different cards in the same org could all pass the same stale "under budget" snapshot | **Confirmed** — reproduced with a budget of 1 and two concurrent claims for two different cards, both returning a claim | `6c6c841` |
| R3-03 | `notification_email` accepted any address with zero verification the org controlled it; the round-2 budget bounded but didn't close the spam-relay risk | **Confirmed** | `5787fd2` |
| R3-04 | `get_feedback_period_analytics`'s caller-controlled `p_days` fed straight into `generate_series` with no validation | **Confirmed** — called directly as `authenticated` with `p_days=100000`; forced a corresponding unbounded series before this fix | `0cd3de1` |
| R3-05 | Applying the alert-cooldown-protecting trigger to production at the same time as the migration introducing the RPC that replaces the old direct-`UPDATE` code path would break currently-deployed application code mid-rollout | **Confirmed** — the currently-deployed `master` code (pre-round-2) does perform that direct `UPDATE` | `6c6c841` |
| R3-06 | `claim_negative_alert_send` recorded a log row as an alert "actually sent" before any recipient lookup or Resend call — a missing recipient or delivery failure still consumed cooldown/budget | **Confirmed** | `6c6c841` |
| R3-07 | `get_feedback_overview_snapshot` retained an unintended `service_role` `EXECUTE` grant; `private.alert_email_log`'s documented "RLS enabled" claim didn't match reality | **Confirmed** — `has_function_privilege('service_role', 'get_feedback_overview_snapshot(bigint)', 'EXECUTE')` returned `true` before this fix | `fcae7c1` |

No finding was rejected, and none required a scope divergence from what the review asked for — round 3's asks were all implementable in full within this pass (unlike round 2's R2-08, which round 3 itself later pushed back on for being only partially complete — see § 2).

## 2. Where this round differs from round 2's own precedent

Round 2 (`DECISIONS.md` § "R2-08") deliberately deferred building notification-recipient verification, judging the org-wide budget a sufficient interim mitigation and the full confirmation flow disproportionate to fold into that pass. **Round 3's own review pushed back on that judgment call directly** (R3-03), and this pass concluded the deferral was the wrong call for a public-facing spam-relay vector — not that the original cost/benefit reasoning was inaccurate, but that "cheaper for this pass" isn't the right axis to optimize when the alternative is a real, if budget-bounded, abuse vector shipping to production. The confirmation flow is now built in full; see `DECISIONS.md` for the complete before/after reasoning, including why this is treated as a revision of a documented decision rather than something to silently redo without comment.

## 3. What changed, structurally

- **1 migration revised in place** (`20260904135437_server_owned_alert_cooldown_and_budget.sql`) plus **5 new migrations**, none applied to production: an advisory-lock-serialized, attempt-tracking rewrite of the alert-cooldown/budget RPC; the alert-cooldown trigger split into its own later migration; `p_days` validation on the analytics period function (its `p_since` parameter removed, old overload dropped); the stray `service_role` grant revoked and RLS enabled on `private.alert_email_log`; the full notification-email-confirmation flow (3 new functions, 3 new columns); and that flow's own enforcement trigger, split out the same way as the alert cooldown's.
- **A new production rollout-ordering pattern, now used twice.** R3-05 identified a real hazard — applying a column-protecting trigger at the same time as the migration that introduces the RPC replacing the old direct-write code path breaks currently-deployed application code in the gap before new code deploys. Both the alert-cooldown trigger and the new notification-email-change trigger now ship as separate, later "enforce" migrations, documented in `DATABASE_SCHEMA.md` § "Rollout ordering" and this document's § 6.
- **A committed, automated privilege-matrix test** (`e2e/rpc-privilege-matrix.spec.ts`) replaces what had been a manual `has_function_privilege()`/`pg_proc.proacl` check during development — covers all 6 RPCs introduced or touched across rounds 2–3 against the full `anon`/`authenticated`/`service_role` matrix, plus a raw ACL scan for a lingering `PUBLIC` grant.
- **A real concurrency test replaces a sequential loop** for the org-wide budget (`e2e/negative-feedback-alert-abuse.spec.ts`'s new R3-02 test) — `Promise.all`-driven genuinely concurrent HTTP requests (PostgREST opens an independent connection/transaction per request), not a loop that could never have demonstrated the race either way.
- **Documentation corrected, not just appended to** — `SECURITY.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `STATUS.md`, `DECISIONS.md`, `e2e/README.md` all updated in place: the analytics RPC role table, the alert-abuse-controls section, the test-config-safety section, and the R2-08 decision entry all now describe the round-3 state, not left describing round 2's.

## 4. Verification results (exact, not summarized)

```
npm ci                    — clean, 802 packages, 0 vulnerabilities
npm run typecheck         tsc --noEmit         — clean
npm run lint               eslint                 — clean
npm run test                vitest run              — 88/88 passed
npm run test:e2e             playwright test           — 80/80 passed, against the isolated project, SUPABASE_DB_URL
                                                            exported so the two connection-requiring spec files
                                                            (rpc-privilege-matrix, location-deactivation-race)
                                                            actually ran rather than silently skipped
npm run build                 next build                 — clean, all 18 routes compile
```

`supabase db advisors --type all` against the isolated project: no issues, after every migration applied.

**"Migration replay from an empty database" was deliberately not performed**, and this is worth being explicit about rather than silently skipping: the only way to genuinely test that would be either (a) resetting the isolated project's `public`/`private` schemas via raw `DROP SCHEMA`/`CREATE SCHEMA`, which risks silently losing the project's own `ALTER DEFAULT PRIVILEGES` configuration — the exact mechanism R2-07 and R3-07 are both about — meaning a reset-then-replay could *change* the very default-grant behavior these findings depend on, invalidating the test it was meant to be; or (b) provisioning a brand-new Supabase project, which is new billable cloud infrastructure this task's autonomous-execution scope doesn't cover creating unprompted. What was done instead, which is a stronger check for the specific thing that actually matters here: every new/revised migration was applied incrementally to the existing isolated project (which itself reflects an unbroken real migration history), `supabase db advisors` confirmed no issues, and `e2e/rpc-privilege-matrix.spec.ts` directly re-derives the actual resulting grants from `pg_proc.proacl`/`has_function_privilege()` against the live database — checking the real ACL state rather than assuming a reset would replay identically to original provisioning.

Two things caught and fixed during this pass itself, not left for review to catch:
- The tests initially used placeholder Supabase project URLs (`https://isolated-project.supabase.co`) that don't resolve to the real approved project ref — updated to use the actual test project's ref (a public, non-secret value — the same string already sent in every browser request this app makes) so the project-identity validation is tested against something real, not a string that happens to parse as a URL.
- `request_notification_email_change`'s expiry needed to be testable without a real 24-hour wait or writing to a column its own enforcement trigger blocks even the admin client from touching directly — added an optional `p_expires_in_minutes` parameter (same tunable-parameter pattern `claim_negative_alert_send` already used for its cooldown/budget) rather than working around the trigger.

Database confirmed clean of leftover test orgs/users after the full suite, both mid-session and in this final pass.

## 5. Remaining risks / explicitly not addressed

- **The 20/5-minute, 5-minute cooldown, 30/hour, and 24-hour-expiry constants remain untested against real production traffic** — deliberately generous/conservative, easy to retune, correctness under genuine load (as opposed to synthetic test bursts) is unverified. Unchanged from round 2's own equivalent note.
- **`e2e/rpc-privilege-matrix.spec.ts` and `e2e/location-deactivation-race.spec.ts` require `SUPABASE_DB_URL`** and skip (not fail) without it — confirmed they actually ran, not skipped, in this pass's local verification; **CI does not yet have this secret configured**, so they will silently skip in CI until it's added (already wired into `ci.yml`'s `e2e` job env — see `STATUS.md`).
- **No true "replay from empty database" verification** — see § 4 for why, and what was done instead.
- **No QR code generation, org switcher, role-gated authorization, or logo upload UI** — all pre-existing, deliberate MVP-scope decisions, unchanged by this pass.

## 6. Rollout: not yet executed, plan only

Nothing below has been executed. Once approved, this branch now has **two column-protecting triggers that must each be applied as a separate, later production step** after their corresponding "expand" migration and this PR's application code have both landed — not the single migrations-before-merge step round 1 used:

1. Apply the "expand" migrations to production: `20260904130921` through `20260904135437` (revised), `20260904194200`, `20260904194300`, `20260904194400` — everything except the two "enforce" migrations (`20260904194100`, `20260904194500`). `supabase db advisors` against production afterward; confirm migration history in sync.
2. Merge and deploy this PR's application code (the whole branch — old code stops performing any direct write to the protected columns from this point).
3. Confirm the Vercel deployment reflects the merged commit and old server instances have drained.
4. Apply the two "enforce" migrations (`20260904194100_enforce_alert_cooldown_trigger.sql`, `20260904194500_enforce_notification_email_change_trigger.sql`) to production.

**Rollback plan:** the two "enforce" migrations are trivially reversible (`drop trigger`/`drop function`) with no data-loss risk, and — being separate migrations — can be rolled back independently of everything else if a problem is specific to them. The "expand" migrations are additive (new columns, new functions, one revised function body) with no destructive schema change; reverting the corresponding application-code commits plus a follow-up migration dropping the new objects fully reverts each, the same pattern round 2's own rollback plan used.

## 7. Where to be especially critical this round

1. **The R3-02 concurrency fix's lock-key derivation** (`hashtext('claim_negative_alert_send:' || org_id)`) — confirm this can't collide with `create_organization_atomic`'s own advisory lock (a different key domain, hashing a UUID string rather than an org id) in a way that would matter, and that the lock is genuinely released on every exit path (early `return null`, not just the success path).
2. **The expand/deploy/enforce rollout plan itself** (§ 6) — this is new process, not just new code; confirm the sequencing is actually safe and that "old instances have drained" is a checkable condition in this deployment's actual infrastructure (Vercel), not just an assumption.
3. **R3-03's threat model** — confirm the token generation (`pgcrypto`'s `gen_random_bytes(32)`, hashed with SHA-256 before storage) and the enforcement trigger together actually close the "member sets their own token hash and self-confirms" bypass this fix is specifically about, not just that the happy path works.
4. **Whether "migration replay from an empty database" not being performed (§ 4) is an acceptable gap** — judge the reasoning given, not just whether the checklist item is unchecked.
5. **The R3-06 budget-accounting decision** — failed attempts don't count against the org budget, but the per-card cooldown is NOT released on a failed attempt (documented explicitly in the migration and `SECURITY.md`) — confirm that asymmetry is the right call, not an oversight.
