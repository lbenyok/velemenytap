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
| `NEXT_PUBLIC_SUPABASE_URL` | production project | **isolated test project** | production project (or isolated, your choice) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production project | isolated test project | production project |
| `SUPABASE_SECRET_KEY` | production project | isolated test project | production project |
| `NEXT_PUBLIC_SITE_URL` | `https://veleminytap.vercel.app` | the Preview deployment's own URL | `http://localhost:3000` |
| `RESEND_API_KEY` | real key | **unset** | optional |
| `RESEND_FROM_EMAIL` | real sender | **unset** | optional |
| `NEXT_PUBLIC_SENTRY_DSN` | real DSN | **unset** | optional |

**Preview deployments must never point at the production Supabase project** — a PR from an external contributor, or just an unreviewed branch, should not be able to read or write real customer data, and should not be able to send real emails or report real errors to production Sentry. Configure the three Supabase variables with **Preview** scope pointing at the same isolated test project `.env.test.local`/CI already use (round-3 R3-01's `APPROVED_TEST_PROJECT_REF` — see `e2e/support/env.ts`), and leave `RESEND_API_KEY`/`NEXT_PUBLIC_SENTRY_DSN` empty for that scope specifically, mirroring what `e2e/support/env.ts` already force-disables for the test suite itself (round-2 R2-06).

`SUPABASE_DB_URL` is not a Vercel environment variable at all — the deployed application never needs a direct Postgres connection (it only ever talks to Supabase over PostgREST/HTTP via the two keys above). It exists only as a GitHub Actions secret (§ 4) and in local `.env.test.local`/`.env.local`, for the test suite and `scripts/rollout.mjs`.

**Use the connection pooler, not the direct `db.<ref>.supabase.co` host, for `SUPABASE_DB_URL`.** This project's Supabase region only offers the direct host over IPv6, and GitHub Actions runners have no IPv6 egress — a direct connection string fails there with `ENETUNREACH`, discovered firsthand when round-4's now-mandatory CI connection (R4-04) surfaced it as a hard failure instead of a silent skip. The pooler (`aws-<n>-<region>.pooler.supabase.com:6543`, username `postgres.<project-ref>` instead of plain `postgres`) resolves to real IPv4 addresses and works from CI. Get it from the Supabase dashboard → Project Settings → Database → Connection string → **Transaction pooler** (port 6543), for the isolated test project specifically — never production's. `e2e/support/db-connection.ts`'s `projectRefFromDbUrl()` recognizes both the direct and pooler URL forms when validating the project ref, so switching formats doesn't bypass the approved-project check.

## 4. GitHub Actions secrets

Repository Settings → Secrets and variables → Actions:

| Secret | Value | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | isolated test project | `e2e` job |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | isolated test project | `e2e` job |
| `SUPABASE_SECRET_KEY` | isolated test project | `e2e` job |
| `SUPABASE_DB_URL` | isolated test project's **pooler** connection string (not the direct host — see § 3) | `e2e` job (round-4 R4-04: now mandatory, not optional — see `e2e/support/db-connection.ts`) |

All four are checked together by the `check-e2e-secrets` job; missing any one skips the whole `e2e` job with a warning rather than failing CI outright (so a fork/contributor without these secrets still gets a useful, if partial, CI run) — but once the job does run, none of its tests may silently skip for lack of a working database connection (that's the actual R4-04 fix).

Repository Settings → Secrets and variables → Actions → **Variables** tab (not Secrets — this one isn't sensitive):

| Variable | Value |
|---|---|
| `PRODUCTION_HEALTH_URL` | `https://veleminytap.vercel.app/api/health` (optional — the workflow falls back to this exact value if unset) |

## 5. CI gating model (`​.github/workflows/ci.yml`)

```
checks (typecheck, lint, unit tests)
  │
  ├──> e2e (Playwright, needs all 4 secrets from § 4, else skips)
  │       │
  └───────┴──> verify-production-deployment (push to master only)
```

`verify-production-deployment` (round-4 R4-01) runs only on a push to `master`, requires `checks` to have succeeded, and requires `e2e` to not have actively **failed** (a skip, for missing secrets, is tolerated — a failure is not). It polls the live production `/api/health` endpoint for up to 5 minutes until it reports the exact commit SHA that triggered the run, and fails loudly if that never happens. **This is what would have caught the actual incident**: CI would go red on every push to `master` for as long as the Vercel webhook stayed broken, instead of staying silently green while production quietly ran stale code.

### What this repository's CI *cannot* enforce (must be configured by hand, and re-verified periodically)

- **GitHub branch protection / rulesets** (Settings → Branches → Branch protection rules, or Settings → Rules → Rulesets, for `master`): require the `checks` and `e2e` status checks to pass before a PR can merge. This repo does not currently have this configured — set it up, and include `verify-production-deployment` too if you want a merge itself blocked retroactively by production-deploy health (unusual, but possible with a merge-queue-style setup); more commonly this check is treated as post-merge observability rather than a merge gate, since it can only run *after* something is already on `master`.
- **Vercel Deployment Protection / Checks** (Vercel Project Settings → Git → Deployment Protection, or the "Checks" API integration if enabled for your plan): Vercel can be configured to wait for GitHub Actions check runs to report success before promoting a deployment to Production, rather than promoting as soon as the build itself finishes. Without this, exactly what was observed on this project's most recent rollout can recur: Vercel finished (and promoted) a Production build before the Playwright job had even started. Consult Vercel's own current documentation for your plan's exact configuration surface — this changes between plans and over time, and this repository cannot verify or set it for you.

## 6. Health/version verification (`/api/health`)

`app/api/health/route.ts` reports (all non-secret): `environment` (Vercel's `VERCEL_ENV`, or `"development"` locally), `commitSha` (`VERCEL_GIT_COMMIT_SHA`), `commitRef`, and `latestMigration`/`migrationCount` — the migration this specific build of the code was compiled expecting the database schema to already have (generated at build time by `scripts/generate-build-info.mjs`, wired into `predev`/`prebuild`). Returns HTTP 503 with `ok: false` if `environment` is `production` or `preview` but no commit SHA is present — see § 2's note on why that combination is possible and exactly what it means (the Git connection or system-env-var setting is broken) rather than assuming it's a false alarm.

Public, unauthenticated route (`proxy.ts`'s `PUBLIC_PATHS`) — everything it returns is already either non-secret build metadata or already-public Vercel system information.

## 7. Expand / deploy / enforce rollout procedure

Use this whenever a migration set includes a column-protecting **enforce** migration (one that installs a trigger rejecting a write pattern the *currently-deployed* code still performs) alongside **expand** migrations that introduce the replacement code path. Round 2/3 both needed this; it will very likely come up again.

**Do this with `scripts/rollout.mjs`, not by hand.** The manual round-2/round-3 procedure (move the enforce migration files out of `supabase/migrations/`, push, restore them, *look at the Vercel dashboard and decide by eye whether the new code seems live*, then apply the enforce migrations) is exactly how production ended up briefly running enforce triggers against code that couldn't satisfy them — the deployment-status assumption was wrong, and nothing caught it. The script automates the same file-staging mechanism but gates every phase transition on an actual `/api/health` check instead of a human's guess:

```bash
node scripts/rollout.mjs \
  --db-url "$PRODUCTION_DB_URL" \
  --enforce 20260904194100_enforce_alert_cooldown_trigger.sql,20260904194500_enforce_notification_email_change_trigger.sql \
  --expected-sha "$(git rev-parse HEAD)" \
  --health-url https://veleminytap.vercel.app/api/health
```

What it does, in order (see the script's own header comment for the full detail): applies every pending migration *except* the ones named by `--enforce` → polls `/api/health` until it reports `--expected-sha`, failing closed (never proceeding) if that doesn't happen within the timeout → waits a drain window → re-checks health once more → **only then** applies the `--enforce` migrations → does a final check that nothing is left pending.

Add `--dry-run` to preview exactly what phase 1 would push, with nothing applied and no health polling. This script performs real production writes exactly like `supabase db push` does — Claude Code's auto-mode classifier blocks it from running this directly against production regardless of in-conversation approval; a human runs it, the same as a raw `supabase db push` would need to be.

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
