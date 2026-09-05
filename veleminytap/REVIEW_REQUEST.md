# Review Request — Round 5

This is a response to a fourth-round independent review — this time of `master` itself, following the round-2/3 merge, the discovered-and-fixed Vercel deployment gap, and an unreviewed dashboard visual restyle, all of which happened directly on `master` without their own review cycle. Read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, and the new `DEPLOYMENT.md`, all updated to reflect the current, post-round-4-fix state.

**Reviewed state:** `master` at commit `443ea98` (the dashboard restyle commit — the last commit before this round's review).
**Branch:** `fix/round4-review-findings`, based on `443ea98` — **not merged, no production changes of any kind** (no new migrations this round). Everything below was validated against the same isolated Supabase test project prior rounds established, never against production.
**Commit range:** `443ea98..3b7d0e4` (4 commits, 30 files, +1247/-118 within that range; the fuller `4f984e6..HEAD` range including the pre-round-4 deployment-gap-fix and restyle work is +1468/-168 across 37 files).
**All 8 round-4 findings addressed** — verified independently (reproduced the 768px overflow directly, computed the wordmark's contrast ratio against the exact WCAG formula rather than trusting the finding's number, ran the rollout script end-to-end against the isolated project with real pending migrations and a fake health server), then fixed. Verdict: **all 8 confirmed, no findings rejected**. See § 1 for the finding-by-finding detail.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| R4-01 | Production had no way to prove which commit it was actually running — how the Vercel deployment gap went undetected across three review rounds | **Confirmed** — this is a direct, named consequence of the incident recorded in `STATUS.md` | `5c74cd0` |
| R4-02 | Production could promote before Playwright finished; no documented required-check/gating model | **Confirmed** — Vercel's dashboard showed the most recent Production deployment as successful before the `e2e` job had even started, observed directly during this round's own verification | `3b7d0e4` (documentation; cannot configure GitHub/Vercel settings from this repository) |
| R4-03 | The manual expand/deploy/enforce rollout depended on an unvalidated human judgment call about deployment status | **Confirmed** — this is exactly what went wrong in the round-2/3 rollout | `d553380` |
| R4-04 | `SUPABASE_DB_URL` optional in CI; two security-relevant spec files silently skipped without it | **Confirmed** | `5c74cd0` |
| R4-05 | Dashboard nav links had no accessible name below `lg` (icon-only, label hidden) | **Confirmed** — reproduced by inspecting the accessibility tree at tablet width | `06b453a` |
| R4-06 | Dashboard header could not fit mobile widths | **Confirmed** — reproduced directly at 320/375/768px; 768px specifically still overflowed even after an initial `md`-breakpoint fix attempt, corrected to `lg` | `06b453a` |
| R4-07 | Gradient wordmark's cyan endpoint fails contrast in light mode | **Confirmed** — computed at 1.81:1 via the actual WCAG relative-luminance formula, matching the finding's own figure exactly | `06b453a` |
| R4-08 | Stale/contradictory documentation across several files | **Confirmed** | `3b7d0e4` |

No finding was rejected.

## 2. Where this round differs from the finding's exact ask

- **R4-02** could not be fully executed as configuration — this repository has no access to GitHub branch protection/ruleset settings or Vercel's Deployment Checks/Protection dashboard. `DEPLOYMENT.md` § 5 documents the exact settings needed and is explicit that they are unconfigured as of this PR, not silently assumed done.
- **R4-07** was fixed for the dashboard wordmark specifically, as named. The public homepage (`app/page.tsx`) uses the identical original gradient in two places with the same underlying contrast defect and was deliberately left unchanged — see `DECISIONS.md` § "R4-07" for why (the review's own design constraint said not to redesign unrelated product surfaces), flagged explicitly as a follow-up rather than silently left inconsistent.

## 3. What changed, structurally

- **A new public endpoint, `/api/health`**, and a new CI job (`verify-production-deployment`) that polls it after every push to `master` — this is the concrete mechanism that would have caught the actual historical incident automatically, rather than relying on someone eventually noticing.
- **`SUPABASE_DB_URL` is now enforced, not just requested**, in CI — `e2e/support/db-connection.ts` (new, replacing duplicated `tryConnect()` helpers in two spec files) throws instead of skipping when CI is set and the connection can't be established or doesn't resolve to the approved isolated project.
- **A real rollout script** (`scripts/rollout.mjs`) replaces the manual file-shuffling procedure, gating every phase transition on the new `/api/health` check.
- **The dashboard nav was substantially rebuilt**, not patched: every link's icon+label pair now renders together always (no responsive hiding of the label), and the six links move into a `shadcn`/Base-UI `Sheet` below `lg` rather than attempting to keep a shrunk inline nav visible at every width.
- **`DEPLOYMENT.md`** is new — the standing runbook `STATUS.md`'s narrative entries and `README.md`'s one-line deploy command were never actually a substitute for.

## 4. Verification results (exact, not summarized)

```
npm run typecheck        tsc --noEmit          — clean
npm run lint               eslint                  — clean
npm run test                 vitest run              — 100/100 passed (7 files; +14 from this round: /api/health, db-connection)
npm run test:e2e             playwright test          — 90/90 passed (16 files; +10 from this round: dashboard-nav-accessibility),
                                                          against the isolated project, SUPABASE_DB_URL exported so the two
                                                          connection-requiring specs actually ran
npm run build                 next build                 — clean, 19 routes (including the new /api/health)
git diff --check                                         — clean, no whitespace errors
```

**No test was skipped in this verification run.** `npx playwright test --list` confirmed 90 tests total, matching 90 passed with 0 skipped — the two connection-requiring spec files (`rpc-privilege-matrix`, `location-deactivation-race`) ran for real, not gracefully-skipped, since `SUPABASE_DB_URL` was exported for this run.

`scripts/rollout.mjs` was tested directly against the isolated project (§ "rollout script verification" below), not just read for plausibility.

**None of the above constitutes production verification.** No new migrations exist this round, and nothing was applied to or run against production.

### Rollout script verification

Three separate runs against the isolated test project, each proving a different phase:
1. `--dry-run` with zero pending migrations — confirmed clean no-op behavior and correct argument handling.
2. A real (non-dry-run) run with two genuine, harmless pending migrations (one "expand," one matching the `--enforce` list) and a `--health-url` that would never resolve — confirmed the expand migration was applied, the enforce migration's file was correctly staged out and then restored to `supabase/migrations/`, and the script failed closed at the health-check gate without ever attempting the enforce migration.
3. The same scenario with a local fake HTTP server always reporting the expected commit — confirmed all six phases (expand → health poll → drain → smoke check → enforce → final verification) complete correctly end-to-end.

Both test migration files and their migration-history entries were removed/reverted afterward (`supabase migration repair --status reverted`); the isolated project's `supabase_migrations` history was separately found out of sync with its actual schema (from earlier rounds' raw-SQL application during this session's own verification work) and repaired (`--status applied`) before this testing began, so it reflected a consistent baseline.

### Non-regression check (per the task's explicit requirement)

Re-running the full suite (above) exercises every one of the named invariants directly: `tenant-isolation.spec.ts` (tenant isolation/RLS), `rpc-privilege-matrix.spec.ts` (the deliberate admin/RLS-bypass paths and their exact grants), `notification-email-verification.spec.ts` (notification-recipient verification), `negative-feedback-alert-abuse.spec.ts`/`negative-feedback-alert-finalize.spec.ts` (abuse controls), `lib/sentry-redact.test.ts` (Sentry redaction), and `review-gating.spec.ts` (the Google Review non-gating invariant, all five ratings). All passed, unchanged from their pre-round-4 behavior — this round's diff touches none of the files these tests exercise (confirmed via `git status`/`git diff --stat` before committing: no migrations, no RLS policies, no Server Actions for feedback/tenant-scoped data, no Sentry config).

## 5. Remaining risks / explicitly not addressed

- **GitHub branch protection and Vercel Deployment Checks are not configured** — `DEPLOYMENT.md` § 5 documents exactly what's needed; this repository has no access to set either.
- **The homepage's identical wordmark/hero gradient-contrast defect was not fixed** — deliberately out of this round's scope (§ 2); tracked in `DECISIONS.md`.
- **`verify-production-deployment` has never actually fired for a real failure** — it's reasoned from the actual historical incident, but its own alarm is unproven in anger. `TEST_PLAN.md`'s "Known gaps" section flags deliberately testing it once (e.g., a temporarily-wrong expected SHA on a non-`master` branch) as still worth doing.
- **Preview-environment Vercel variables (pointed at the isolated project, per `DEPLOYMENT.md` § 3) are not yet configured** — documented, not applied; this repository cannot set Vercel project environment variables.
- **`SUPABASE_DB_URL` as a GitHub Actions secret** — if not already added following round 3's equivalent note, it remains needed; round 4 makes its *absence* louder (the whole `e2e` job skips with an explicit warning naming all four required secrets) rather than newly requiring it.

## 6. Rollout: nothing to apply

No new migrations this round. Once merged, the round-4 changes take effect purely as application code and CI configuration — no expand/deploy/enforce sequencing is needed for this PR itself. The new `verify-production-deployment` CI job will run automatically on the merge commit once this branch lands on `master`, which is itself the first real (if hopefully uneventful) test of R4-01's fix.

**Rollback plan:** every change in this round is either a new, isolated file (`app/api/health/`, `scripts/rollout.mjs`, `scripts/generate-build-info.mjs`, `e2e/support/db-connection.ts`, `DEPLOYMENT.md`) or a scoped edit to existing files (the dashboard nav/layout, `proxy.ts`'s allowlist, `ci.yml`, doc corrections) — reverting the commits in this PR fully reverts the round, with no data or migration state to reconcile.

## 7. Where to be especially critical this round

1. **`/api/health`'s fail-closed logic** (`app/api/health/route.ts`) — confirm the `environment === "production" || environment === "preview"` check is the right boundary for when a missing commit SHA should be treated as an error, not a normal local-dev state.
2. **`scripts/rollout.mjs`'s failure modes** — confirm every phase genuinely fails closed (no migration left half-applied, no enforce migration ever reachable without a passing health check) by reading the script directly, not just trusting the three verification runs described in § 4.
3. **The `lg` breakpoint choice** (R4-06) — confirm 1024px is actually the right cutoff for this product's real usage pattern (an operational dashboard likely used on laptops/desktops primarily), not just "wide enough to pass the four tested widths."
4. **Whether R4-02's documentation-only response is acceptable** for a "medium" severity finding, given the actual configuration remains undone — judge whether this should have blocked the PR rather than being handed off as a manual checklist.
5. **The homepage gradient-contrast scope decision** (§ 2) — confirm leaving it is the right call given the review's own "don't redesign unrelated surfaces" constraint, versus treating an identical, already-diagnosed accessibility defect as worth fixing regardless of which page it's on.
