# Status

Last updated: 2026-09-03, end of the "Phase 14" master-build-prompt gap-fill session.

## Done

Everything through the product skill's MVP priority list (auth → orgs → locations → NFC cards → public landing page → feedback submission → inbox → statuses/resolution → negative-feedback notifications → basic analytics → Google Review CTA → production deployment) was built and browser-verified in earlier sessions, then deployed to Vercel production (https://veleminytap.vercel.app).

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

- **Sentry.** Not started. Needs a redaction rule for `feedback_text` before it ships (see `SECURITY.md` § Error handling / logging) — that's the reason it wasn't rushed in alongside everything else this session.
- **Playwright/e2e automation.** The review-gating check was performed manually and is documented as a standing checklist in `TEST_PLAN.md`, but isn't yet a repeatable automated test. No CI pipeline exists yet either, and an e2e suite with nothing to run it in has limited ongoing value — see `TEST_PLAN.md` § Known gaps for the reasoning on sequencing this with CI.
- **Tenant-isolation automated test.** Verified manually in earlier phases; not codified as a repeatable test.
- **QR code generation for NFC cards.** Explicitly lower priority per the product skill ("do not allow QR work to delay core functionality") — not started, and nothing currently blocks a business from printing/encoding the public URL onto a physical NFC tag by other means in the meantime.
- **Redis-backed rate limiting.** Deliberate MVP gap, not a bug — full reasoning in `SECURITY.md`.
- **Org switcher, role-gated authorization, `feedback_notes` table, logo upload UI.** All deliberate MVP-scope decisions — see `DECISIONS.md` for the reasoning behind each.

## What's needed from the user before the next round

- Confirmation that the Supabase Auth **Site URL** and **Redirect URLs** were actually added for the production domain (https://veleminytap.vercel.app) in the Supabase dashboard — this was flagged at the end of the deployment phase with "I'll do it now," but no confirmation of completion has been received since. Auth flows on production can't be trusted to work correctly until this is confirmed.
- A Resend account/API key, whenever ready — the app runs fully without one today (negative-feedback alert emails are skipped with a console warning), so this isn't blocking, just needed for that feature to actually deliver emails in production.
- A decision on whether/when to prioritize Sentry vs. Playwright/CI vs. further product features, since all three are real remaining gaps and none is strictly higher priority than the others from the code alone.

## Not yet committed / pushed / deployed as of this writing

All Phase 14 work described above exists in the local working tree only. The next actions are: commit (conventional-commit-style, split by type), push to GitHub, and redeploy to Vercel production — see `REVIEW_REQUEST.md` for the itemized diff this covers.
