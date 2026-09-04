# Review Request — Round 3

This is a response to a second, independent round-2 review of `master` (which itself was round 1's fix response, merged and deployed) — read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, and `DECISIONS.md`, all updated to reflect the current, post-round-2-fix state (not left describing round 1). If you're a different reviewer picking this up cold: those five documents are still the right starting point, in that order; this document is the delta since round 2's review, not a replacement for them.

**Reviewed commit:** `8f05205` (`master`, the state after round 1's PR #1 squash merge `e2bbb7b`).
**Branch:** `fix/round2-review-findings`, off `8f05205` — **not merged, not deployed, no production migration applied**, per this task's explicit constraint. Everything below was validated against the same isolated Supabase test project round 1 established (`.env.test.local`, gitignored), never against production.
**Commit range:** `8f05205..f468ac3` (6 commits, 42 files, +2412/-722).
**All 9 round-2 findings addressed** — verified independently against actual code/database state first (empirical reproductions, real concurrent database connections, `pg_proc.proacl`/`has_function_privilege()` introspection — not accepted on faith), then fixed where confirmed. Verdict: **all 9 confirmed, no findings rejected**. See § 1 for the finding-by-finding detail.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R2-01 | Round-1's open-redirect fix (origin-matching the parsed candidate) was necessary but not sufficient: a dot-segment payload (`/a/..//evil.example/path`) and a same-origin absolute URL with a double-slash pathname both produce a same-origin-validated *result* that is itself a protocol-relative URL | **Confirmed** — reproduced against Node's own `URL` parser (the same WHATWG implementation browsers use) | `e54a3bb` |
| R2-02 | Round-1's analytics fix (page-fetching past PostgREST's 1000-row cap) still had a silent correctness ceiling at its own `MAX_ROWS = 5000` | **Confirmed** — same class of bug at a higher threshold | `78a29b3` |
| R2-03 | `OFFSET`-based pagination is not consistent under concurrent writes; an `id` secondary sort key (which fixed the *inbox's* pagination) does not fix this — ordering-among-ties and offset-stability-across-requests are different properties | **Confirmed** | `78a29b3` |
| R2-04 | A failed analytics query could surface as an apparently-valid, silently empty/partial stats page instead of an explicit unavailable state | **Confirmed** | `78a29b3` |
| R2-05 | `submit_feedback_atomic` locked only the `nfc_cards` row (`for update of c`), not the `locations` row it also reads `status` from — a location deactivated mid-transaction could still receive a feedback insert | **Confirmed** — reproduced with two real concurrent Postgres connections (not simulated) | `7997f49` |
| R2-06 | e2e test config could silently fall back to production credentials, and `reuseExistingServer` could reuse a wrongly-configured already-running server with no verification | **Confirmed** | `955fc81` |
| R2-07 | `revoke execute on function ... from public;` alone did not remove `anon`/`authenticated`'s ability to call either round-1 RPC, due to this project's `ALTER DEFAULT PRIVILEGES` configuration | **Confirmed** — `pg_proc.proacl`/`has_function_privilege()` showed both grants intact | `78a29b3` |
| R2-08 | The negative-feedback alert cooldown (`nfc_cards.last_negative_alert_at`) was a plain, tenant-writable column; an org's own authenticated session could reset it directly via `UPDATE`, and the per-card rate limit did nothing to bound total email volume across an org's cards | **Confirmed** — reproduced with a real authenticated session | `ed8c8a4` |
| R2-09 | The card editor rendered the same fully-editable location dropdown for an existing card as for a new one, even though the database has rejected relocation since round 1 | **Confirmed** | `f468ac3` |

No finding was rejected. One implementation choice diverged partially from the finding's full scope, argued in `DECISIONS.md` rather than silently substituted — see § 2.

## 2. Where the fix diverged from the finding's full scope

- **R2-08 (tenant-controlled email-abuse limits):** the finding named three sub-problems — a tenant-writable cooldown, a per-card-only rate limit, and unverified `notification_email` recipients. The first two are fixed completely. Recipient verification is **not** built this pass — a real fix needs its own email-confirmation flow (a new pending-vs-confirmed column pair, a confirmation route, new Resend-triggered copy, new UI states), which is a separate feature disproportionate to bundle into this fix without its own design pass. An organization-wide hourly send budget bounds the blast radius of an unverified recipient to a hard, low ceiling in the meantime. A domain-matching heuristic was considered and rejected as actively wrong for this product (small-business owners routinely sign up with a personal address while wanting alerts routed to a different business domain). Full reasoning: `DECISIONS.md` § "R2-08."

**Ask for round 3:** independently judge whether leaving recipient verification out (with the budget as a partial mitigation) is an acceptable scope boundary, or whether it should have blocked this pass entirely.

## 3. What changed, structurally

- **4 new database migrations** (`supabase/migrations/2026090413*`), none applied to production: tenant-scoped SQL analytics aggregation, explicit RPC role allowlists (5 functions total, up from 2), locking the location row in `submit_feedback_atomic`, and the server-owned alert cooldown + org budget (`private.alert_email_log`, a new table with its own explicit `service_role` grants — RLS bypass does not imply schema/table grants, a real bug hit and fixed while building this). All validated against the isolated test project with `supabase db advisors` after each (no issues).
- **Analytics rebuilt, not patched.** `features/analytics/aggregate.ts`, `fetch-all-rows.ts`, and their tests are deleted (confirmed dead via grep first) — replaced by two SQL functions (`get_feedback_overview_snapshot`, `get_feedback_period_analytics`) and a new `features/analytics/parse-snapshots.ts` that turns their `jsonb` result into a discriminated `{ unavailable: true } | {...}` type, closing R2-04 (no more silently-empty stats on a failed query) as a side effect of the same rewrite.
- **5 new/extended e2e spec files** against the isolated project: `analytics-aggregation` (5500/6000-row volume tests plus a concurrency test), `location-deactivation-race` (real two-`pg`-connection concurrency — the only way to actually interleave two transactions, since PostgREST/supabase-js has no cross-request transaction control), `negative-feedback-alert-abuse`, `nfc-card-location-lock`, and an extended `redirect-safety` (7 tests, up from 4). Plus 5 new `lib/safe-redirect.test.ts` unit tests (34 total), 8 new `features/analytics/parse-snapshots.test.ts`, and 6 new `e2e/support/env.test.ts`.
- **Test infrastructure hardened**, not just used. `e2e/support/env.ts` now fails closed (throws, does not fall back to `.env.local`) on missing isolated-project config, and force-clears `RESEND_API_KEY`/`NEXT_PUBLIC_SENTRY_DSN` for every test run regardless of what the environment has set. A new unauthenticated diagnostic route (`/api/e2e-config-check`) plus a Playwright `globalSetup` (`e2e/support/verify-server-config.ts`) confirms the actually-running server's configured Supabase URL matches the isolated project before any test executes — this is what makes `reuseExistingServer` safe rather than a blind trust.
- **Documentation corrected, not just appended to.** `SECURITY.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `STATUS.md`, `DECISIONS.md` all updated to describe the current state — the analytics-approach reversal, the RPC grant model (now 5 functions with an explicit allowlist table), the alert-cooldown ownership model, and the test-config safety model are all corrected in place, including marking round 1's own "page-by-page fetching, not SQL aggregation" decision as superseded with an explicit account of what the original proportionality reasoning got wrong.

## 4. Verification results (exact, not summarized)

```
npm run typecheck        tsc --noEmit           — clean, re-run after every commit in this range
npm run lint              eslint                  — clean, re-run after every commit
npm run test              vitest run               — 83/83 passed (net of new safe-redirect/parse-snapshots/env tests added and aggregate/fetch-all-rows tests deleted along with the code they covered)
npm run test:e2e          playwright test            — 49/49 passed, against the isolated project, real browser
npm run build              next build                  — clean, all 16 routes compile (3 static, 12 dynamic, 1 not-found)
```

Database cleanliness (orgs/users remaining in the isolated test project) confirmed 0/0 after the full e2e run, before each commit.

**None of the above constitutes production verification.** Every test ran against the isolated Supabase test project; no production migration has been applied and no production data was read or written as part of this pass. This is stated explicitly per this task's own instruction not to let local/isolated-project success stand in for it.

Two real bugs were found and fixed during this pass itself, not left for review to catch:
- `claim_negative_alert_send` initially failed with "permission denied for schema private" for the admin (`service_role`) client — `bypassrls` (which `service_role` has) bypasses row-level security, but schema/table `GRANT`s are a separate privilege type it does not imply; fixed by adding explicit `grant usage on schema private to service_role` and `grant select, insert on private.alert_email_log to service_role` to the migration.
- Playwright's default `testMatch` (`*.spec.ts` **or** `*.test.ts`) picked up the new `e2e/support/env.test.ts` (a Vitest-only file), producing `Vitest mocker was not initialized in this environment`; fixed with an explicit `testMatch: "**/*.spec.ts"` in `playwright.config.ts`.

## 5. Remaining risks / explicitly not addressed

- **R2-08's recipient verification** — deliberately out of scope this pass; the org-wide budget mitigates but does not close it. See § 2 and `DECISIONS.md`.
- **Sentry source-map upload** — unchanged from round 1, still unconfigured (needs a credential, out of scope).
- **The rate-limit, alert-cooldown, and org-budget constants are untested against real production traffic patterns** — deliberately generous, easy to retune, correctness under genuine load (as opposed to synthetic test bursts) remains unverified.
- **`e2e/location-deactivation-race.spec.ts` requires direct Postgres port access** (5432/6543) and skips gracefully (not a failure) if unavailable in the environment running the tests — confirm it actually ran (not skipped) in whatever environment reviews this.
- **No QR code generation, org switcher, role-gated authorization, or logo upload UI** — all pre-existing, deliberate MVP-scope decisions, unchanged by this pass.

## 6. Rollout: not yet executed, plan only

This task's constraints (no merge, no deployment, no production migration, no production secret changes) apply for the duration of this review. **Nothing below has been executed.** Once approved, the plan mirrors round 1's own migrations-before-merge sequencing, for the same reason (no window where deployed code doesn't match the live schema):

1. Apply the 4 new migrations to **production** via `supabase db push` (round 1 needed the transaction pooler, port 6543, since the direct/IPv6 connection was unreachable from the network in use at the time — check which is reachable when this actually runs). Run `supabase db advisors` against production afterward; confirm migration history is in sync (12/12).
2. Merge `fix/round2-review-findings` into `master`.
3. Confirm the Vercel deploy from `master` reflects the merge commit.

**Rollback plan, if needed:** `20260904131144_enforce_rpc_role_allowlists.sql` is pure grant changes, trivially reversible (re-grant the prior state). `20260904132712_lock_location_in_feedback_submission.sql` only widens a lock clause on an existing function — reversible by restoring the prior function body, no data-loss risk. `20260904135437_server_owned_alert_cooldown_and_budget.sql` adds a new table and a new trigger on an existing column; reverting means dropping the trigger, the function, and the table, and reverting `features/notifications/negative-feedback-alert.ts`'s commit — no existing data is altered by the migration itself (the trigger only restricts future writes). `20260904130921_tenant_scoped_analytics_aggregation.sql` adds two new functions with no prior callers; reverting the two application-code commits that call them (`78a29b3`) plus a follow-up migration dropping the functions fully reverts it, though `aggregate.ts`/`fetch-all-rows.ts` would need to be restored from git history rather than simply un-deleted.

## 7. Where to be especially critical this round

1. **The R2-05 reproduction methodology** — confirm `e2e/location-deactivation-race.spec.ts`'s two-`pg`-connection interleaving actually demonstrates blocking (not just absence of a visible failure), and that it's a materially different race from round 1's card-deactivation test (finding #6) rather than a restatement of it.
2. **The RPC role-allowlist table** (`SECURITY.md`/`DATABASE_SCHEMA.md`) — confirm all 5 functions' grants match what's actually in `pg_proc.proacl` on the isolated project, not just what the migration files say should be true.
3. **The R2-08 scope decision** (§ 2) — judge it on its own merits: is an org-wide budget a sufficient interim mitigation for an unverified recipient, or does this warrant treating recipient verification as a blocking requirement rather than a documented follow-up?
4. **Whether the SQL aggregation functions' `SECURITY INVOKER` + RLS-bound-client-only calling convention is actually maintained everywhere they're called** — a future caller reaching either function through the admin client (bypassing RLS) would silently break the tenant-isolation guarantee the current calling convention relies on; confirm no such call site exists.
5. **The analytics rewrite's consistency semantics claim itself** (`SECURITY.md` § "Analytics correctness") — confirm the stated guarantee (one call = one consistent snapshot; two separate calls are not guaranteed to agree) is both accurate and sufficient for what the dashboard actually needs from it.
