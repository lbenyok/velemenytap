# Status

Last updated: 2026-09-03, after the "Phase 14" master-build-prompt gap-fill session and follow-up Resend, Sentry, and Playwright/CI wiring passes.

## Done

Everything through the product skill's MVP priority list (auth → orgs → locations → NFC cards → public landing page → feedback submission → inbox → statuses/resolution → negative-feedback notifications → basic analytics → Google Review CTA → production deployment) was built and browser-verified in earlier sessions, then deployed to Vercel production (https://veleminytap.vercel.app).

**Resend is now live.** `RESEND_API_KEY`/`RESEND_FROM_EMAIL` are set in both `.env.local` and Vercel production, and the full `submitFeedbackAction` → `after()` → `sendNegativeFeedbackAlert` code path was exercised end-to-end (real signup, real org/location/card, a real 1-star submission through `/r/{publicId}`) with no error logged. **Known limitation:** the account has no verified sending domain yet, so it's on Resend's shared `onboarding@resend.dev` sender, which only delivers to the email address that owns the API key (confirmed via direct API calls — sends to any other address are rejected with `403 validation_error`). Negative-feedback alerts will silently fail to deliver (Resend rejects the send; the app logs it via `console.error` per its "never throws" design, but the customer-facing response is unaffected) for any real business's `notification_email` or member email until a domain is verified at resend.com/domains and `RESEND_FROM_EMAIL` is updated to use it. This is a hard blocker for the notification feature actually working for a real customer, not just a nice-to-have.

**Sentry is now live.** `@sentry/nextjs` is wired up for client, server, and edge runtimes (`instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`), plus `app/global-error.tsx` to catch root-layout rendering errors. `NEXT_PUBLIC_SENTRY_DSN` is set in both `.env.local` and Vercel production (as a `config`-type var — a DSN is meant to be public, not a secret; Vercel's credential-detection prompt was overridden deliberately, not by accident). A deliberately-thrown test error was triggered locally through a temporary route (removed afterward) and confirmed reaching Next.js's error handling correctly. **Redaction is enforced**: `lib/sentry-redact.ts`'s `beforeSend` hook strips `feedback_text`/`internal_note` (and their camelCase equivalents) from request data, extra context, and breadcrumbs on every event before it leaves the app — covered by 6 Vitest unit tests including a circular-reference case. Source map upload (via `authToken`/`org`/`project` in `withSentryConfig`) was deliberately skipped for now — see `DECISIONS.md`.

**Playwright e2e and CI are now live.** `e2e/review-gating.spec.ts` automates the product skill's Review-Gating Regression Test for real: for each rating 1–5, a real browser loads the public feedback page, submits, and asserts the Google Review CTA is visible with the correct URL — plus a duplicate-submission test. All 6 tests were run and passed against the real linked Supabase project (`npm run test:e2e`), with test data (a disposable org/location/five cards) confirmed cleaned up afterward. `.github/workflows/ci.yml` (at the repo root) now runs typecheck/lint/Vitest on every push/PR unconditionally, and the Playwright job runs too once `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY` are added as GitHub Actions repo secrets (skips gracefully until then — see `e2e/README.md`). **Deliberate tradeoff:** e2e tests run against the same Supabase project as dev/production, not an isolated Docker-based local stack — see `DECISIONS.md` for the full reasoning and when to revisit it.

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
- **A genuinely isolated e2e environment.** e2e tests run against the shared Supabase project (see `DECISIONS.md`); revisit once real customers are on the product.
- **Tenant-isolation automated test.** Verified manually in earlier phases; not codified as a repeatable test.
- **QR code generation for NFC cards.** Explicitly lower priority per the product skill ("do not allow QR work to delay core functionality") — not started, and nothing currently blocks a business from printing/encoding the public URL onto a physical NFC tag by other means in the meantime.
- **Redis-backed rate limiting.** Deliberate MVP gap, not a bug — full reasoning in `SECURITY.md`.
- **Org switcher, role-gated authorization, `feedback_notes` table, logo upload UI.** All deliberate MVP-scope decisions — see `DECISIONS.md` for the reasoning behind each.

## What's needed from the user before the next round

- ~~Confirmation that the Supabase Auth Site URL/Redirect URLs were added for production.~~ **Confirmed done.**
- **Verify a sending domain in Resend** (resend.com/domains) so alert emails can actually reach real recipients, then update `RESEND_FROM_EMAIL` (locally and in Vercel) to an address on that domain. Until then, alerts only deliver to the Resend account's own verified email.
- ~~A decision on whether/when to prioritize Sentry vs. Playwright/CI vs. further product features.~~ **Both are done.**
- **Add three GitHub Actions repo secrets** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` — same values as `.env.local`) via Settings → Secrets and variables → Actions, so the Playwright e2e job actually runs in CI instead of skipping. No CLI access was available to add these directly (`gh` isn't installed in this environment).
- Optional: a `SENTRY_AUTH_TOKEN` + org/project slugs, if/when readable (non-minified) stack traces in the Sentry dashboard become worth the extra setup.

## Deployed

Phase 14 (feat/test/docs, commits `47ec557`/`b9baf5f`/`1daf267`), the Resend wiring (`6b859e0`), and Sentry wiring are all committed, pushed to GitHub, and live on Vercel production. Playwright/CI is committed and pushed as of this update; see the final commit hash reported at the end of this session.
