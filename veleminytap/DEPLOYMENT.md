# Deployment Runbook

Round-4 findings R4-02/R4-08. This is the single source of truth for how this app gets from a commit to production, replacing scattered, some-stale notes across `README.md`/`STATUS.md`. Historical narrative (what happened, when, in earlier rounds) stays in `STATUS.md`; this file is the current, standing procedure.

**The single biggest lesson behind this document existing at all**: for an extended period spanning three review rounds, `master` had multiple real, reviewed, merged fixes that were never actually live — the Vercel Git integration had silently stopped deploying, and nothing in this repository's own tooling noticed, because nothing checked. Every section below exists to make that specific failure mode either impossible or loudly detected.

## 1. Repository and application layout

The git repository root (one level above this file's directory) also contains unrelated files (design assets, `.claude/` skill config) — the actual Next.js application lives entirely inside `veleminytap/`. `.github/workflows/` lives at the true repo root (GitHub requires this), one level above `veleminytap/`; every workflow job sets `working-directory: veleminytap` accordingly.

## 2. Vercel project configuration (external — this repository cannot enforce any of this)

These are Vercel Project Settings, set once by hand and periodically worth re-verifying — they are exactly the kind of thing that can silently drift (as happened) with no code-visible symptom until you specifically check for one:

| Setting | Required value | Where |
|---|---|---|
| **Root Directory** | `veleminytap` | Settings → General → Build and Deployment |
| **Production Branch** | `master` | Settings → Git |
| **Connected Git Repository** | `lbenyok/velemenytap`, connection healthy (not just displaying a repo name — see § 7 for how that can lie) | Settings → Git |
| **Automatically expose System Environment Variables** | Enabled | Settings → Environment Variables |
| **Framework Preset** | Next.js | Settings → General |

If **Root Directory** is wrong, the build fails immediately with `Couldn't find any pages or app directory` — loud, at least. If the **Git connection** is broken, nothing fails at all; deployments simply stop being created, silently, forever, which is what actually happened here. **Automatically expose System Environment Variables** must be on for `/api/health` (§ 6) to report anything — without it, `VERCEL_GIT_COMMIT_SHA`/`VERCEL_ENV` are unset even in a genuinely healthy production deployment, which `/api/health` cannot distinguish from a broken one on its own (this is precisely why the CI verification job in § 5 exists as an independent check, not just a self-report).

## 3. Environment variables and scopes

| Variable | Production | Preview | Development (local `.env.local`) |
|---|---|---|---|
| `APP_ENV` | `production` | `preview` | **unset** |
| `NEXT_PUBLIC_SUPABASE_URL` | production project | **isolated test project** | production project (or isolated, your choice) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production project | isolated test project | production project |
| `SUPABASE_SECRET_KEY` | production project | isolated test project | production project |
| `NEXT_PUBLIC_SITE_URL` | `https://veleminytap.vercel.app` | the Preview deployment's own URL | `http://localhost:3000` |
| `RESEND_API_KEY` | real key | **unset** | optional |
| `RESEND_FROM_EMAIL` | real sender | **unset** | optional |
| `NEXT_PUBLIC_SENTRY_DSN` | real DSN | **unset** | optional |

**`APP_ENV` (round-6 finding R6-06) — not yet configured; an owner action.** `/api/health`'s fail-closed logic used to infer "is this a genuine production/preview build" from `VERCEL_ENV` (round-4 R4-01) and then, after round-5's own fix turned out to rest on a false premise, from a build-time snapshot of it (`BUILD_VERCEL_ENV`) — but per Vercel's own current documentation, `VERCEL_ENV` is a **System Environment Variable**, gated by the "Automatically expose System Environment Variables" toggle at *both* build and runtime, with no build-time carve-out. A project with that toggle disabled would have had `BUILD_VERCEL_ENV` null too, and the health check silently reported a healthy "development" instead of the failure it was built to catch — see `DECISIONS.md` for the full correction. `APP_ENV` is a plain, **ordinary** project environment variable (not a System one) set directly in Vercel Project Settings → Environment Variables, scoped `production`/`preview` per row above — ordinary env vars are never gated by that toggle, so `APP_ENV` cannot be silently withheld by the exact misconfiguration this check exists to detect. **This must be added in the Vercel dashboard for `/api/health` to report anything other than a 503 "cannot establish deployment environment" in Production/Preview** — this repository cannot set it.

**Preview deployments must never point at the production Supabase project** — a PR from an external contributor, or just an unreviewed branch, should not be able to read or write real customer data, and should not be able to send real emails or report real errors to production Sentry. Configure the three Supabase variables with **Preview** scope pointing at the same isolated test project `.env.test.local`/CI already use (round-3 R3-01's `APPROVED_TEST_PROJECT_REF` — see `e2e/support/env.ts`), and leave `RESEND_API_KEY`/`NEXT_PUBLIC_SENTRY_DSN` empty for that scope specifically, mirroring what `e2e/support/env.ts` already force-disables for the test suite itself (round-2 R2-06).

`SUPABASE_DB_URL` is not a Vercel environment variable at all — the deployed application never needs a direct Postgres connection (it only ever talks to Supabase over PostgREST/HTTP via the two keys above). It exists only as a GitHub Actions secret (§ 4) and, locally, as a shell-exported environment variable for the test suite and `scripts/rollout.mjs` — **not** something `.env.test.local` supplies: `e2e/support/env.ts` deliberately excludes it from the keys that file can populate (round-5 finding R5-13; `REQUIRED_KEYS` in that file lists only the three PostgREST-facing keys), precisely so a developer can't assume dropping it into that file is enough — see `e2e/README.md`'s "Running locally" section for the actual `export SUPABASE_DB_URL=...` step.

**Use the connection pooler, not the direct `db.<ref>.supabase.co` host, for `SUPABASE_DB_URL`.** This project's Supabase region only offers the direct host over IPv6, and GitHub Actions runners have no IPv6 egress — a direct connection string fails there with `ENETUNREACH`, discovered firsthand when round-4's now-mandatory CI connection (R4-04) surfaced it as a hard failure instead of a silent skip. The pooler (`aws-<n>-<region>.pooler.supabase.com:6543`, username `postgres.<project-ref>` instead of plain `postgres`) resolves to real IPv4 addresses and works from CI. Get it from the Supabase dashboard → Project Settings → Database → Connection string → **Transaction pooler** (port 6543), for the isolated test project specifically — never production's. `e2e/support/db-connection.ts`'s `projectRefFromDbUrl()` recognizes both the direct and pooler URL forms when validating the project ref, so switching formats doesn't bypass the approved-project check.

## 4. GitHub Actions secrets

Repository Settings → Secrets and variables → Actions:

| Secret | Value | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | isolated test project | `e2e` job |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | isolated test project | `e2e` job |
| `SUPABASE_SECRET_KEY` | isolated test project | `e2e` job |
| `SUPABASE_DB_URL` | isolated test project's **pooler** connection string (not the direct host — see § 3) | `e2e` job (round-4 R4-04: now mandatory, not optional — see `e2e/support/db-connection.ts`) |

All four are checked together by the `check-e2e-secrets` job (`scripts/check-e2e-secrets.mjs`, round-5 R5-01). **The behavior differs by trust level, corrected from an earlier, stale version of this document that described only the fork case as if it applied universally:** for a push to `master` or a pull request from a branch within this same repository (both of which GitHub Actions *does* give repository secrets to), a missing secret **fails CI outright** — round-4 R4-04 made `SUPABASE_DB_URL` specifically mandatory for exactly this reason (a security-relevant privilege matrix or concurrency guarantee silently not running must never look like a clean pass), and round-5 R5-01 closed the gap where the job itself only ever warned-and-skipped regardless of trust level. Only a **fork pull request** — the one case GitHub Actions genuinely never hands repository secrets to — still skips the `e2e` job gracefully with a warning. See § 5's "Fork contribution flow" for what that skip means for branch protection (round-6 R6-08) and how a maintainer runs the real suite against a fork PR's code before merging it.

Repository Settings → Secrets and variables → Actions → **Variables** tab (not Secrets — this one isn't sensitive):

| Variable | Value |
|---|---|
| `PRODUCTION_HEALTH_URL` | `https://veleminytap.vercel.app/api/health` (optional — the workflow falls back to this exact value if unset) |

## 5. CI gating model (`​.github/workflows/ci.yml`)

```
checks (typecheck, lint, unit tests)
  │
  ├──> e2e (Playwright, needs all 4 secrets from § 4, else skips -- fork PRs only)
  │       │
  │       └──> e2e-gate (round-6 R6-08: fails unless e2e genuinely SUCCEEDED --
  │       │      a skip does not count; needs no secrets, checks out nothing)
  │       │
  └───────┴──> verify-production-deployment (push to master only)
```

`verify-production-deployment` (round-4 R4-01) runs only on a push to `master`, requires `checks` to have succeeded, and requires `e2e` to have actively **succeeded** — round-5 R5-01 tightened this from an earlier `!= 'failure'` check (which a *skipped* e2e job, e.g. from missing secrets, also satisfied) to `== 'success'`, so a skip is no longer indistinguishable from a pass for this specific gate. It polls the live production `/api/health` endpoint for up to 5 minutes until it reports the exact commit SHA that triggered the run, and fails loudly if that never happens. **This is what would have caught the actual incident**: CI would go red on every push to `master` for as long as the Vercel webhook stayed broken, instead of staying silently green while production quietly ran stale code.

### Fork contribution flow and its security tradeoff (round-6 finding R6-08)

GitHub Actions never exposes repository secrets to a `pull_request` run whose head is a fork — by design, and this repository does not use `pull_request_target` to work around it (that would mean running untrusted fork code with secrets available, a materially worse tradeoff). The consequence: `check-e2e-secrets` correctly reports `configured: false` for a fork PR, and `e2e` correctly **skips** rather than fails.

The problem round 6 found is what a skip means for branch protection: GitHub treats a skipped job as satisfying a required status check, identically to one that ran and passed. Once required checks are configured (the still-open owner action below), a fork PR could merge having never run the RPC privilege matrix, the RLS tests, or anything else database-dependent — silently defeating round-4 R4-04's entire guarantee for exactly the untrusted-contribution path it matters most for. Fixed with a new job, `e2e-gate` — treats anything other than `e2e` having genuinely **succeeded**, including a skip, as a failure. It needs no secrets and checks out no untrusted code, so a fork PR gains nothing by triggering it.

**Require `e2e-gate` in branch protection, not `e2e` itself** (see the owner action below). For a genuine external contribution to a fork PR: a maintainer who has reviewed the diff pushes the fork's branch (or a copy of it) to a branch **within this repository** — at that point it is a same-repo ref, GitHub hands it secrets, and `e2e` runs and reports for real. There is currently no lower-friction path than that manual step, and building one (a maintainer-comment-triggered re-run against the fork's exact commit, for instance) is real additional infrastructure this repository does not have a demonstrated need for yet, given no active external contributor flow exists today — revisit if that changes.

### What this repository's CI *cannot* enforce (must be configured by hand, and re-verified periodically)

- **GitHub branch protection / rulesets** (Settings → Branches → Branch protection rules, or Settings → Rules → Rulesets, for `master`): require the `checks` and `e2e-gate` (not `e2e` — see the fork contribution flow above, round-6 R6-08) status checks to pass before a PR can merge. This repo does not currently have this configured — set it up, and include `verify-production-deployment` too if you want a merge itself blocked retroactively by production-deploy health (unusual, but possible with a merge-queue-style setup); more commonly this check is treated as post-merge observability rather than a merge gate, since it can only run *after* something is already on `master`.
- **Vercel Deployment Protection / Checks** (Vercel Project Settings → Git → Deployment Protection, or the "Checks" API integration if enabled for your plan): Vercel can be configured to wait for GitHub Actions check runs to report success before promoting a deployment to Production, rather than promoting as soon as the build itself finishes. Without this, exactly what was observed on this project's most recent rollout can recur: Vercel finished (and promoted) a Production build before the Playwright job had even started. Consult Vercel's own current documentation for your plan's exact configuration surface — this changes between plans and over time, and this repository cannot verify or set it for you.
- **`APP_ENV`** (§ 3, round-6 R6-06) — a plain Vercel project environment variable, `production`/`preview` scoped, that `/api/health` now requires to report anything other than a fail-closed 503 in a real deployment. Not yet configured.

## 6. Health/version verification (`/api/health`)

`app/api/health/route.ts` reports (all non-secret): `environment`, `commitSha` (`VERCEL_GIT_COMMIT_SHA`), `commitRef`, and `latestMigration`/`migrationCount` — the migration this specific build of the code was compiled expecting the database schema to already have (generated at build time by `scripts/generate-build-info.mjs`, wired into `predev`/`prebuild`). `environment` comes from `APP_ENV` (§ 3, round-6 R6-06) when set to `production`/`preview`, or `"development"` when `NODE_ENV === "development"` (i.e. `next dev`, the one value it actually sets) — **never** from any Vercel-managed System Environment Variable, since those are exactly what a disabled "Automatically expose System Environment Variables" toggle can silently withhold (round 5's own fix, R5-05, rested on the false premise that `VERCEL_ENV` was exempt from that at build time; it isn't — see `DECISIONS.md`). In a genuine production-mode build (`NODE_ENV` not `"development"` — round 7, R7-07 tightened this from the earlier, fail-open `NODE_ENV !== "production"`, which had incorrectly treated an unset, malformed, or `"test"` value the same as local development) that cannot establish `APP_ENV` as `production`/`preview`, or that can but has no commit SHA visible, this returns HTTP 503 with `ok: false` rather than ever inferring "development" from missing Vercel metadata — see § 2's note on why a broken Git connection or system-env-var setting produces exactly that missing-metadata shape. **`APP_ENV` is a deployment-identity variable, not something local development needs** — it stays unset in `.env.local`/local development by design (see § 3's table), and this route treats "unset" as the expected local-dev case precisely because `NODE_ENV=development` already establishes that identity by itself.

Public, unauthenticated route (`proxy.ts`'s `PUBLIC_PATHS`) — everything it returns is already either non-secret build metadata or already-public Vercel system information.

## 7. Expand / deploy / enforce rollout procedure

Use this whenever a migration set includes a column-protecting **enforce** migration (one that installs a trigger rejecting a write pattern the *currently-deployed* code still performs) alongside **expand** migrations that introduce the replacement code path. Round 2/3 both needed this; it will very likely come up again.

**Do this with `scripts/rollout.mjs`, not by hand.** The manual round-2/round-3 procedure (move the enforce migration files out of `supabase/migrations/`, push, restore them, *look at the Vercel dashboard and decide by eye whether the new code seems live*, then apply the enforce migrations) is exactly how production ended up briefly running enforce triggers against code that couldn't satisfy them — the deployment-status assumption was wrong, and nothing caught it. The script automates the same file-staging mechanism but gates every phase transition on an actual `/api/health` check instead of a human's guess.

### 7a. `prepare` and `finalize` are two separate commands, run at genuinely different times

Found during an independent review: the script's original single-command design required `--expected-sha` to already be known *before* the migration this whole procedure exists to protect against had even happened — but Vercel's auto-deploy from `master` starts immediately on merge, completely independent of when (or whether) this script runs, and there is no Vercel Deployment Check configured to make it wait (§ 5). That created a real window where new application code needing a not-yet-added column could go live before the expand migration creating it had been applied. Worse, a GitHub squash or merge commit produces a brand-new SHA distinct from the PR branch's own HEAD, so pre-computing `--expected-sha` from the branch before merging named a commit that would never actually appear in `/api/health`'s response.

The fix is to never need `--expected-sha` until the commit it names genuinely exists: `prepare` applies only the expand migrations (safe by construction, before any merge) and needs no SHA at all; the owner then merges and deploys by hand, through GitHub/Vercel as normal; `finalize` is run afterward with the **actual resulting** SHA, obtained after the merge — never a SHA computed before it.

**Step 1 — before merging, confirm `APP_ENV` is already set in Vercel for this environment.** This must happen **before** the merge in step 3 triggers a deployment, not after — found during an independent review: Vercel environment variable changes never take effect on a deployment that has already been built, only on the *next* one, so setting `APP_ENV` after merging would leave the deployment the merge just triggered still running without it, and step 4's health check below would (correctly) refuse to pass. Check Vercel Project Settings → Environment Variables for `APP_ENV` scoped `production`/`preview` per § 3's table:
- **Already set correctly** (a prior rollout already configured it): nothing to do, proceed to step 2.
- **Not set, or wrong**: set/correct it now, in this step, before merging anything. If a deployment has *already* happened before you notice this (e.g. you're reading this step out of order, or `APP_ENV` was changed after an earlier merge), setting it alone is not enough — you must also **trigger a fresh deployment** (Vercel dashboard → Deployments → Redeploy, or push an empty commit) before step 4's check can ever pass, since the already-built deployment will never pick up the change on its own.

**Step 2 — before merging, run `prepare`:**

```bash
node scripts/rollout.mjs prepare \
  --target production \
  --db-url "$PRODUCTION_DB_URL" \
  --expand 20260905193325_server_owned_notification_email_change_budget.sql,20260906110000_fix_claim_negative_alert_send_clock_timestamp.sql,20260906120000_fix_request_notification_email_change_reserved_at_clock_timestamp.sql,20260906130000_add_onboarding_tour_status.sql,20260907150000_add_organization_billing.sql,20260907160000_fix_organization_billing_grandfathering_and_event_ordering.sql,20260907170000_rename_billing_last_synced_column.sql,20260907180000_add_billing_activated_at.sql,20260907190000_add_billing_pending_checkout_intent.sql \
  --enforce 20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql,20260906100000_drop_ambiguous_request_notification_email_change_overload.sql
```

This applies only the `--expand` migrations and then verifies exactly the `--enforce` set remains pending. It touches no application code and needs no commit SHA, so it's safe to run before the merge even exists — by the time Vercel starts deploying the new code, the column/function/trigger it depends on is already there. **Re-derive the exact `--expand`/`--enforce` lists from `supabase migration list --db-url "$PRODUCTION_DB_URL"` at the time you actually run this** — see "Current pending migration set" below for a snapshot as of this PR, which will go stale the moment a further migration lands.

**Step 3 — merge and deploy, then read back the real SHA.** Merge the PR through GitHub as normal (squash or merge commit, whichever this repo's convention is) and let Vercel's auto-deploy run. Once it's merged, get the **actual** resulting commit on `master` — e.g. `git rev-parse origin/master` after fetching, or the merge commit SHA GitHub reports on the PR — never the pre-merge branch HEAD, which a squash/merge will not match.

**Step 4 — before running `finalize`, verify the live deployment directly — a testable checklist, not a assumption:**

```bash
curl -s https://<production-domain>/api/health | tee /dev/stderr | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf-8"));
  const expectedSha = process.argv[1];
  const ok = body.ok === true && body.environment === "production" && body.commitSha === expectedSha;
  console.error(ok ? "PASS" : "FAIL: " + JSON.stringify(body));
  process.exit(ok ? 0 : 1);
' "<the actual post-merge SHA from step 3>"
```

All three must hold before proceeding — a partial match is not a pass:
- `"ok": true` (not a fail-closed 503 — see § 6 for exactly when this is false).
- `"environment"` is `"production"` (or `"preview"`, matching `--target`) — a mismatch here means step 1's `APP_ENV` check either wasn't actually satisfied on the live deployment, or was set to the wrong scope.
- `"commitSha"` equals the real SHA from step 3 exactly — anything else means the deployment that's live isn't the one this rollout is about, most commonly because the build is still in progress (wait and retry) or `APP_ENV` was set too late (see step 1's redeploy note).

This is the same check `finalize` itself performs automatically in its own step 2, and `finalize` will correctly refuse to proceed if it fails — running it manually here first is for faster, cheaper feedback (seconds, not the full `--deploy-timeout-seconds` wait) before committing to the rest of the rollout, not a substitute for `finalize`'s own gate.

**Step 5 — run `finalize` with the real SHA:**

```bash
node scripts/rollout.mjs finalize \
  --target production \
  --db-url "$PRODUCTION_DB_URL" \
  --enforce 20260906090000_fix_confirm_toctou_and_revoke_leaked_token_grant.sql,20260906100000_drop_ambiguous_request_notification_email_change_overload.sql \
  --expected-sha "<the actual post-merge SHA from step 3>"
```

`finalize` first verifies that only the `--enforce` migrations are still pending — **it refuses outright if anything else is pending** (an expand migration that never finished, most likely meaning `prepare` didn't run, ran against a different database, or was itself interrupted). It then polls `/api/health` until it reports `--expected-sha` in the target's expected environment (failing closed, never proceeding, if that doesn't happen within the timeout) — **this health check always runs, even when nothing is left pending to apply** (found during an independent review: it used to skip straight to success in that case, which meant an out-of-band or premature enforce migration, or a stale/wrong `--expected-sha`, could look identical to a genuine completed rollout without the live deployment ever actually being checked). Only after the health check passes does it wait a drain window, re-check health once more, and apply the `--enforce` migrations, finishing with a check that nothing is left pending.

**Both commands are safely resumable.** Re-running `prepare` after it already fully or partially succeeded is a no-op for whatever already applied and simply finishes the rest — it does not demand that an expand migration still be pending just because a fresh run would expect that. Re-running `finalize` after it already fully succeeded is likewise a no-op (nothing pending, nothing to apply), not an error. What remains a hard failure in both is anything *unexpected*: an `--enforce` migration that's somehow already gone during `prepare` (anomalous, since `prepare` stages those files out of the directory before its own `db push` runs), or anything pending during `finalize` that isn't in `--enforce`.

### Current pending migration set (verify before every real rollout — this goes stale the moment a further migration lands)

**This example lists every migration actually still pending against production as of this PR** (the second independent-review round on the PR #3/PR #4 integration) — migrations 1 through 17 (everything through round 3) were already applied in the "Merged to production (2026-09-05)" rollout `STATUS.md` records; an earlier version of this example listed only migrations 18–23 (round 8's own set), then only 18–25, each time omitting migrations added by a later round — corrected here to include all six of 23 through 28, all of which must be applied before the new code that reads their columns/writes their tables is promoted. Re-derive this list from `supabase migration list --db-url "$PRODUCTION_DB_URL"` before running the real commands, rather than trusting this example to stay current as further rounds land.

**Why `20260906130000` (the onboarding-tour-status column) must be `--expand`, not left out or applied after deploy** (found during an independent review of round 8): the new dashboard layout code in this PR reads `organizations.onboarding_tour_status` on every dashboard request to decide whether to show the first-time tour, and the column must already exist before that code can run at all — a missing column is a hard query error, not a soft "just don't show the tour" fallback. Deploying the new application code before this migration applies would break every dashboard page load in production. Putting it in `--expand` (applied during `prepare`, before the merge that triggers the code deploy) is what prevents that: the column exists, with every pre-existing organization already reading `'completed'` (see the migration's own comment and `DATABASE_SCHEMA.md` § "Onboarding tour state" for why the backfill default doesn't touch `updated_at`), well before any request can reach code that queries it. Getting this ordering backwards is exactly the deployment-race failure mode `prepare`/`finalize`'s split exists to prevent for `--enforce` migrations, just triggered by the opposite direction (new code needing a column that isn't there yet, rather than old code needing a function that's already gone).

**Why `20260907150000` through `20260907190000` (the billing tables, and their grandfathering/event-ordering/rename/`activated_at`/checkout-lease columns) must all be `--expand`, for the identical reason as `20260906130000` above** — found during two successive independent reviews that each caught manifest entries the previous version was still missing: `app/dashboard/layout.tsx`'s paywall queries `organization_billing`, including `grandfathered_at` (`20260907150000`/`160000`) and `activated_at` (`20260907180000`), on **every** non-billing dashboard route once this PR's code is live; the webhook writes `last_synced_at` (`20260907170000`) on every event it processes; `createCheckoutSessionAction` reads/writes the checkout lease columns (`20260907190000`) on every checkout attempt. If any of these hasn't applied yet, the corresponding request fails outright with a missing-relation or missing-column error, not a graceful fallback. None of these five migrations removes or restricts anything the *currently-deployed* (pre-this-PR) application code depends on — all are purely additive (`create table`, `alter table ... add column`, a column rename, a backfill `insert`) — so there is no compatibility window requiring `--enforce`'s later timing; the only requirement is that all five exist before the new code's first request, which is exactly what `--expand` guarantees.

**Why `20260906090000`/`20260906100000` are `--enforce`, not `--expand`, despite an earlier handoff (round 6's, quoted in `REVIEW_REQUEST_ROUND8.md`) claiming neither needed staged rollout at all**: production's *currently-deployed* application code still calls the round-3 3-argument `request_notification_email_change` RPC to change the notification-email recipient — this PR's replacement code (calling the 2-argument version) has not gone live yet. `20260906090000` revokes that 3-argument function's grant, and `20260906100000` (new this round, R7-03) drops it outright; applying either before the new application code deploys would break the live "change notification email" settings action immediately (`permission denied` or `PGRST202`, respectively) for a feature that currently works — a real, self-inflicted outage, not a bounded acceptable-risk window. See `DATABASE_SCHEMA.md` § "Rollout ordering" for the full correction and why this was wrong in the original round-6 handoff.

### 7b. Shared argument details

**`--expand` (prepare only) and `--enforce` (both commands) are required, not optional** (round-5 R5-03) — every migration pending against `$PRODUCTION_DB_URL` that isn't named in `--enforce` must be named in `--expand` explicitly when running `prepare` (an empty string, `--expand ""`, if genuinely none); the script validates this exactly and refuses to guess. A flag that belongs to the other command (`--expected-sha`/`--drain-seconds`/`--deploy-timeout-seconds` passed to `prepare`, or `--expand` passed to `finalize`) is rejected outright, not silently accepted.

**`--target`** (round-6 R6-07) selects a fixed entry from the committed `scripts/rollout-environments.json` manifest — it replaces the old caller-supplied `--allowed-origin`/`--health-url` arguments entirely, binding the origin, health URL, expected `environment` value, and the Supabase project ref `--db-url` must resolve to, all together; the script rejects a `--db-url` that doesn't match `--target`'s own project ref before touching anything, and (round-7 R7-04) rejects a manifest entry whose `healthUrl` doesn't share `allowedOrigin`'s exact origin, and never follows a redirect while polling health — see `SECURITY.md` § "`allowedOrigin`/`healthUrl` were recorded but never actually checked against each other" for the full reasoning. Passing the now-removed `--allowed-origin`/`--health-url` flags, or any other unrecognized flag, is rejected outright rather than silently ignored.

**`--expected-sha` (finalize only) must be the full 40-character commit SHA** (round-6 R6-11) — a short one can never match `/api/health`'s own full-length `commitSha`, and is now rejected before any database work rather than only after a multi-minute timeout has elapsed. It must be the **actual** post-merge SHA (step 3 above), never one computed before merging.

**A subprocess failure never prints `$PRODUCTION_DB_URL`'s credentials, on any path** (round-7 R7-02) — every `supabase` CLI invocation is wrapped so that a non-zero exit's error message, stdout, and stderr all have connection-string credentials redacted before the wrapper's caller ever sees them, not just the script's own happy-path log line. This matters specifically because this script's own errors are exactly the kind of thing that might get pasted into a chat, a ticket, or piped into a log aggregator when a rollout fails partway through.

Add `--dry-run` to either command to preview what it would push, with nothing applied (and, for `finalize`, no health polling). This script performs real production writes exactly like `supabase db push` does — Claude Code's auto-mode classifier blocks it from running this directly against production regardless of in-conversation approval; a human runs it, the same as a raw `supabase db push` would need to be.

## 8. Rollback procedure

- **Application code**: revert the offending commit(s) on `master` and push — the same CI/deploy path applies to a revert as to any other commit, including `verify-production-deployment` confirming the revert itself actually went live.
- **Expand migrations**: additive by construction (new columns, new functions, at most a `create or replace` on an existing function) — write a follow-up migration that drops the new objects or restores the prior function body. No data loss risk since nothing destructive was in the expand phase to begin with.
- **Enforce migrations**: `drop trigger`/`drop function` in a follow-up migration — trivially reversible, and safe to do independently of the expand-phase migrations since they're separate files.
- **Never** hand-edit the production schema outside a migration file, including during a rollback — see `DATABASE_SCHEMA.md`'s Database Change Workflow.

## 9. Post-deployment smoke tests

After any production deploy, whether via the automated `verify-production-deployment` CI job or by hand:

1. `curl https://veleminytap.vercel.app/api/health` — expect `"ok":true` and `commitSha` matching the deployed commit.
2. Load `https://veleminytap.vercel.app/` in a real browser — no console errors, homepage renders.
3. Load `/login` — renders, no console errors.
4. **Never** log into the dashboard with real credentials from an automated tool, and never run the e2e suite against the production Supabase project — the isolated test project (§ 3) exists specifically so verification never touches real customer data.
