# Status

Last updated: 2026-09-04, after merging the review-response branch and applying its migrations to production. Prior entry: 2026-09-04, after responding to the independent engineering review requested before that (branch `fix/independent-review-findings`, off commit `a3d5ce1`).

## Merged to production (2026-09-04)

[PR #1](https://github.com/lbenyok/velemenytap/pull/1) merged into `master` as squash commit `e2bbb7b`, CI green. Rollout order was deliberately migrations-before-merge: CI's e2e secrets were updated to the isolated test project's values first (confirmed green), then all 5 new migrations were applied to **production** (`supabase db push` via the transaction pooler — the direct/IPv6 connection was unreachable from the network in use at the time; `supabase db advisors` against production reported no issues afterward, migration history confirmed in sync, 8/8), then the PR was merged. Vercel's deploy from `master` follows its normal auto-deploy flow — not separately verified as part of this exchange; confirm the live deployment reflects `e2bbb7b` before treating this as fully rolled out. `REVIEW_REQUEST.md` § 6 has the exact sequence and the rollback plan if a problem surfaces.

## Review-response pass (2026-09-04)

All 11 findings from the independent review verified against the actual code (not accepted on faith) and fixed where confirmed; see the finding-by-finding verdict handed back to the reviewer for the full detail. In brief:

- **Confirmed and fixed, all with new migrations against a newly-provisioned isolated Supabase test project (not the shared dev/production one) and new automated tests:** Sentry redaction (4 real bugs — see `SECURITY.md`), the open-redirect in both `next`-param redirect call sites, the `feedback_update` RLS policy's missing column-level restriction, `nfc_cards.location_id` relocation, public-submission abuse/email-amplification (a real database-backed rate limit and alert cooldown, not Redis), the public submission path's active-status check-then-insert race, the analytics row-cap silent truncation (confirmed empirically: 1200 seeded rows, `.limit(5000)` requested, 1000 returned), organization-onboarding's non-atomicity/non-idempotency, and the feedback inbox's cursor pagination correctness under tied `created_at` values.
- **New test coverage**, all run against the isolated project: `e2e/feedback-and-card-integrity.spec.ts`, `e2e/public-submission-safety.spec.ts`, `e2e/feedback-pagination.spec.ts`, `e2e/analytics-row-cap.spec.ts`, `e2e/organization-onboarding.spec.ts`, `e2e/tenant-isolation.spec.ts`, `e2e/redirect-safety.spec.ts`, plus 29 new `lib/safe-redirect.test.ts` unit tests, 22 rewritten `lib/sentry-redact.test.ts` unit tests, and 7 new `features/analytics/fetch-all-rows.test.ts` unit tests. 35 e2e tests and 82 unit tests, all green.
- **Test infrastructure**: e2e/db tests now run against a dedicated, isolated Supabase project (`.env.test.local`, gitignored) instead of the shared dev/production one flagged in the prior entry's "Deliberate tradeoff" — see `e2e/README.md`. ~~CI's e2e job secrets still need updating~~ — done in the merge that followed this pass, see "Merged to production" above.
- **Documentation corrected**, not just code: `SECURITY.md`'s admin-client-consumer count was wrong (claimed two, actually four at review time); now lists all three current admin-client consumers plus the two `SECURITY DEFINER`/`SECURITY INVOKER` database functions that are the other RLS-bypass category, and the "no rate limiting" / "no tenant-isolation test" claims in this file's own prior "Not done" section (below) are corrected rather than left stale.
- **Not part of this pass** (production migration/deployment): done in the merge that followed, once explicitly approved — see "Merged to production" above.

## Review-prep pass (2026-09-04, no new functionality)

Full verification re-run from a clean state, all green: `npm run typecheck`, `npm run lint`, `npm run test` (30/30 Vitest), `npm run test:e2e` (6/6 Playwright against the real linked Supabase project, test data confirmed cleaned up), `npm run build` (production build succeeds). See `REVIEW_REQUEST.md` for the full external-review handoff — it now covers architecture, every implemented feature, repo structure, database tables, RLS policies, auth/authz, the public submission flow, Google Review link logic, security-sensitive files, all Server Actions/routes, migrations, tests, and known bugs/risks/shortcuts, addressed to an independent senior reviewer (ChatGPT).

**One real bug found during this pass, not introduced in the reviewed diff:** `app/auth/confirm/route.ts` redirects to the raw `next` query parameter after a successful email-confirmation OTP verify, with no same-origin validation — an **open redirect**. Contrast with `features/auth/actions.ts`'s `signInAction`, which validates `next` (`typeof next === "string" && next.startsWith("/") && !next.startsWith("//")`) before redirecting. This file hasn't been touched since it was first written (`ea63f03`, the original auth-flow commit) and was not part of this session's diff — left unfixed deliberately per this pass's explicit "no new functionality" instruction, flagged here and in `REVIEW_REQUEST.md` for the reviewer and for a follow-up fix.

## Done

**The entire product is now in Hungarian, and rebranded to match the real logo.** Every user-facing surface — the new homepage, the public feedback flow (`/r/[publicId]`), auth (login/signup/check-email/link-expired), onboarding, the full dashboard (nav, Overview, Locations, NFC Cards, Feedback inbox, Analytics, Settings), the 404 page, the global error boundary, and the negative-feedback alert email — was translated in place (see `DECISIONS.md` for why in-place rather than an i18n framework). `<html lang="hu">`. Supabase Auth's own English error messages get a small translation lookup (`translateAuthError` in `features/auth/actions.ts`) rather than leaking English on an otherwise-Hungarian sign-in form. Verified for real: logged into a real QA account, walked the Hungarian dashboard nav, and re-ran the 1-star public submission — the Google Review CTA ("Google-értékelés írása") still fires correctly, proving the core no-gating invariant survived the relocalization. `e2e/review-gating.spec.ts` was updated to assert on the new Hungarian button/link text and passes 6/6 against the real app.

The shared `--pf-*` color system (used by both the public feedback page and the homepage) was rebranded from an invented wine/gold palette to navy ink + a blue-to-cyan gradient, matching the user-supplied logo and app icon exactly — variables renamed `--pf-accent`/`--pf-accent-hover`/`--pf-accent-2` (previously `--pf-wine`/`--pf-wine-hover`/`--pf-gold`) since the old names became misleading once they held blue/cyan values.

**A real public homepage now exists at `/`**, replacing the unbuilt Next.js scaffold placeholder — see the homepage-build entry below for what it contains (all copy is now Hungarian as of this pass, superseding the "English, matching the dashboard" choice made when it was first built).

## Done (earlier in this session)

Everything through the product skill's MVP priority list (auth → orgs → locations → NFC cards → public landing page → feedback submission → inbox → statuses/resolution → negative-feedback notifications → basic analytics → Google Review CTA → production deployment) was built and browser-verified in earlier sessions, then deployed to Vercel production (https://veleminytap.vercel.app).

**Resend is fully live, including a verified sending domain.** `velemenytap.hu` is verified in Resend, and `RESEND_FROM_EMAIL` is `alerts@velemenytap.hu` in both `.env.local` and Vercel production (updated from the shared `onboarding@resend.dev` sender). Confirmed via direct API calls: a send to a third-party address (not the Resend account's own email) succeeded once the domain was verified, where it had previously been rejected with `403 validation_error` under the shared sender's restriction — the hard blocker noted below is resolved. The sender display name is `Velemenytap` (ASCII, no diacritics) per explicit request, not `VéleményTap`. The full `submitFeedbackAction` → `after()` → `sendNegativeFeedbackAlert` code path was exercised end-to-end (real signup, real org/location/card, a real 1-star submission through `/r/{publicId}`) with no error logged, prior to the domain switch.

**Sentry is now live.** `@sentry/nextjs` is wired up for client, server, and edge runtimes (`instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`), plus `app/global-error.tsx` to catch root-layout rendering errors. `NEXT_PUBLIC_SENTRY_DSN` is set in both `.env.local` and Vercel production (as a `config`-type var — a DSN is meant to be public, not a secret; Vercel's credential-detection prompt was overridden deliberately, not by accident). A deliberately-thrown test error was triggered locally through a temporary route (removed afterward) and confirmed reaching Next.js's error handling correctly. **Redaction is enforced**: `lib/sentry-redact.ts`'s `beforeSend` hook strips `feedback_text`/`internal_note` (and their camelCase equivalents) from request data, extra context, and breadcrumbs on every event before it leaves the app — covered by 6 Vitest unit tests including a circular-reference case. Source map upload (via `authToken`/`org`/`project` in `withSentryConfig`) was deliberately skipped for now — see `DECISIONS.md`.

**Playwright e2e and CI are now live and fully green, including in CI itself.** `e2e/review-gating.spec.ts` automates the product skill's Review-Gating Regression Test for real: for each rating 1–5, a real browser loads the public feedback page, submits, and asserts the Google Review CTA is visible with the correct URL — plus a duplicate-submission test. `.github/workflows/ci.yml` (repo root) runs typecheck/lint/Vitest on every push/PR, then Playwright against a production build (`npm run build` + `next start`, not `next dev` — Turbopack's dev cold-start was too slow for a CI runner). All three GitHub Actions repo secrets are now configured; the most recent run (`14f5b34`, [run #5](https://github.com/lbenyok/velemenytap/actions/runs/33800333904)) passed end-to-end: 45s checks + 4s secrets gate + 1m43s e2e, **6/6 Playwright tests passed**, test data confirmed cleaned up afterward. **Deliberate tradeoff:** e2e tests run against the same Supabase project as dev/production, not an isolated Docker-based local stack — see `DECISIONS.md` for the full reasoning and when to revisit it.

Getting here took four CI iterations, each a real bug found and fixed via the actual failing run rather than guessed away: (1) a workflow-wide `working-directory` default broke a job with no checkout step, (2) `next dev`'s Turbopack cold-start exceeded Playwright's webServer timeout on a GitHub-hosted runner, (3) the secrets gate only checked one of the three required secrets so a bad value slipped through silently, (4) the actual bad value — the `NEXT_PUBLIC_SUPABASE_URL` secret needed re-pasting. All four are separate commits with the failing-run URL in each message.

This session closed the gap between that MVP and the master build prompt's fuller spec:

- **`feedback.priority`** — generated column (`high`/`medium`/`normal` from rating), surfaced as a badge in the inbox table and detail dialog, with unresolved-high-priority rows visually highlighted.
- **NFC card filter** on the feedback inbox (alongside the existing status/rating/location/date filters).
- **Overview page** — added Today / This week / Unresolved-negative stat tiles and a rating-distribution bar, on top of the existing Total/Average tiles and recent-feedback list.
- **Settings page** — business name, notification email, logo URL (pasted URL, not an upload — see `DECISIONS.md`). `notification_email`, when set, overrides the default owner/admin/manager email fan-out for negative-feedback alerts.
- **`profiles` table** — one row per auth user, auto-created on signup via trigger. Not yet read anywhere in the app (see `DATABASE_SCHEMA.md`).
- **Cookie-based duplicate-submission protection** on the public feedback endpoint (`SECURITY.md` has the full reasoning for why this instead of IP/Redis rate limiting).
- **Vitest unit tests** for `features/analytics/aggregate.ts` and the extracted `features/feedback/schema.ts`, including a schema-level review-gating regression test (`it.each([1,2,3,4,5])`).
- **Full documentation suite** — this file plus `README.md`, `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, `REVIEW_REQUEST.md`.

Everything above was typechecked, linted, and — for the UI-facing pieces — manually verified in a real browser against the real linked Supabase project (`TEST_PLAN.md` has the specifics), with the QA account and data cleaned up afterward.

## Not done / explicitly deferred

- **Sentry source map upload.** Error capture is fully live; source maps (readable stack traces in the dashboard instead of minified ones) need a `SENTRY_AUTH_TOKEN` plus org/project slugs, deliberately skipped for now — see `DECISIONS.md`.
- ~~A genuinely isolated e2e environment.~~ **Done this pass** — see the review-response entry above and `e2e/README.md`.
- ~~Tenant-isolation automated test.~~ **Done this pass** — `e2e/tenant-isolation.spec.ts`.
- **QR code generation for NFC cards.** Explicitly lower priority per the product skill ("do not allow QR work to delay core functionality") — not started, and nothing currently blocks a business from printing/encoding the public URL onto a physical NFC tag by other means in the meantime.
- ~~Redis-backed rate limiting.~~ **Superseded, not simply done** — a database-backed rate limit was built instead (`submit_feedback_atomic`), which closes the actual gap (an unbounded scripted flood) without Redis; see `SECURITY.md` for why Redis specifically remained unnecessary rather than merely deferred.
- **Org switcher, role-gated authorization, `feedback_notes` table, logo upload UI.** All deliberate MVP-scope decisions — see `DECISIONS.md` for the reasoning behind each.
- **Tenant-scoped SQL aggregate functions/views for analytics.** Considered as part of this pass's analytics-truncation fix; page-by-page fetching past the row cap was chosen instead for this MVP stage — see `ARCHITECTURE.md`'s "What's deliberately not built."

## What's needed from the user before the next round

- ~~Confirmation that the Supabase Auth Site URL/Redirect URLs were added for production.~~ **Confirmed done.**
- ~~Verify a sending domain in Resend.~~ **Confirmed done — `velemenytap.hu`, sends to arbitrary recipients working.**
- ~~A decision on whether/when to prioritize Sentry vs. Playwright/CI vs. further product features.~~ **Both are done.**
- ~~Add three GitHub Actions repo secrets.~~ **Confirmed done.** ~~Update them to the isolated test project's values.~~ **Done** — see "Merged to production" above.
- ~~Apply the five new migrations to the production database.~~ **Done** — see "Merged to production" above.
- Confirm the Vercel deployment triggered by the `master` merge actually reflects `e2bbb7b` — not separately verified as part of this pass.
- Optional: a `SENTRY_AUTH_TOKEN` + org/project slugs, if/when readable (non-minified) stack traces in the Sentry dashboard become worth the extra setup.

## Deployed

Phase 14 (feat/test/docs, commits `47ec557`/`b9baf5f`/`1daf267`), the Resend wiring (`6b859e0`), and Sentry wiring are all committed, pushed to GitHub, and live on Vercel production. Playwright/CI is committed, pushed, and passing in CI as of `14f5b34`.
