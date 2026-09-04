# Review Request — Round 2

This is a response to an independent review of `a3d5ce1`, not a from-scratch request — read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, and `DECISIONS.md`, all updated to reflect the current, post-fix state (not left describing what was true at round 1). If you're a different reviewer picking this up cold: those five documents are still the right starting point, in that order; this document is the delta since round 1, not a replacement for them.

**Branch:** `fix/independent-review-findings`, off `a3d5ce1` (the commit round 1 reviewed). **Not merged to `master`, not deployed, not applied to production** — see § "What was deliberately not done" below.
**Commit range:** `5f8436c..7c2062d` (9 commits, 31 files, +2272/-196; `5f8436c` is round 1's `REVIEW_REQUEST.md`/`STATUS.md` baseline).
**All 11 round-1 findings addressed** — verified independently against the actual code first (not accepted on faith), then fixed where confirmed. Verdict: **all 11 confirmed**, no findings rejected. See § 1 for the finding-by-finding detail.

---

## 1. Finding-by-finding verdict and fix

| # | Finding | Verdict | Fix (commit) |
|---|---|---|---|
| 1 | Sentry redaction: 4 bugs (`request.data` redacted in place not dropped, missed JSON-stringified content, repeated-reference and circular-reference leaks) | **Confirmed** — the old test suite literally asserted the circular-reference bug as correct behavior | `894f689` |
| 5 | Open redirect: naive `next.startsWith("/")` check bypassable via `/\evil.example.com` (WHATWG parses a backslash like a forward slash for http/https) | **Confirmed** — reproduced against Node's own URL parser | `894f689` |
| 3 | `feedback_update` RLS policy is row-level only; a member could rewrite `rating`/`feedback_text` via direct `UPDATE`, not just `status`/`internal_note` | **Confirmed** — the migration adding `internal_note` said this out loud and treated it as fine | `3d72150` |
| 4 | Nothing prevented relocating an `nfc_card` to a different `location_id`, letting one card span two locations' feedback history | **Confirmed** | `3d72150` |
| 2 | Public submission has no rate limiting; a scripted flood is also an email-amplification vector (each qualifying submission sends a real alert) | **Confirmed** — the code's own comment said rate limiting was deliberately absent | `8a9487b` |
| 6 | Public submission's active-status check and insert were two separate round trips with no lock between them — a real TOCTOU race | **Confirmed** | `8a9487b` |
| 9 | Feedback inbox cursor pagination ordered/seeked on `created_at` alone; rows with an identical timestamp had no deterministic order and could be silently skipped across a page boundary | **Confirmed** | `b6d6302` |
| 7 | Analytics (`getOverviewStats`/`getAnalyticsData`) requested `.limit(5000)` but PostgREST caps at 1000 (`max_rows`) and truncates silently | **Confirmed empirically** — 1200 seeded rows, 1000 returned | `4b797c0` |
| 8 | Organization onboarding: two non-transactional admin-client inserts, no idempotency, no per-user serialization against a double-submit | **Confirmed** | `1faa370` |
| 10 | No automated tenant-isolation test coverage | **Confirmed as a gap** | `7c2062d` (new suite) |
| 11 | `SECURITY.md` claimed the admin client was used in exactly two places; actually four | **Confirmed** — `grep -rln createAdminClient` found four at the time | Docs rewritten (see § 3) |

No finding was rejected. Two implementation choices diverged from what the review suggested, both argued in `DECISIONS.md` rather than silently substituted — see § 2.

## 2. Where the fix diverged from the review's suggested approach

- **Finding #7 (analytics row cap):** the review's natural suggestion was tenant-scoped SQL aggregate functions/views. Built instead: page-by-page fetching past the 1000-row cap (`features/analytics/fetch-all-rows.ts`), keeping `aggregate.ts`'s existing pure, unit-tested reduction functions untouched. Fully closes the correctness bug; SQL-side aggregation remains the right next step if feedback volume ever makes fetching itself (not correctness) the bottleneck. Full reasoning: `DECISIONS.md` § "Analytics row-cap fix."
- **Finding #2 (rate limiting):** built as a database-backed limit inside the same atomic function that closes finding #6, not a Redis/Upstash limiter. Postgres is already the shared state every serverless request goes through, so no new infrastructure was needed — the original "no rate limiting" reasoning conflated "no in-process limiter" with "no rate limiting at all." Full reasoning: `DECISIONS.md` § "Cookie-based duplicate-submission guard, plus a database-backed rate limit."

**Ask for round 2:** independently judge whether these two substitutions were the right call, not just whether they compile and pass their tests.

## 3. What changed, structurally

- **Isolated test infrastructure, for the first time.** `.env.test.local` (gitignored) points a dedicated, newly-provisioned Supabase project; `e2e/support/env.ts` prefers it over `.env.local`, and `playwright.config.ts` injects its values into the spawned dev/start server so the app under test talks to it too. All 8 new migrations were applied there (never to the shared dev/production project), verified with `supabase db advisors` after each (no issues), and all new tests run against it. **CI's e2e job secrets likely still point at the old shared project** — see `STATUS.md`'s "What's needed from the user."
- **5 new database migrations** (`supabase/migrations/2026090408*`, `2026090409*`): column-restriction and location-immutability triggers, the atomic public-submission function, the pagination index, the atomic onboarding function. All committed, none applied to production. `DATABASE_SCHEMA.md` § "Database functions callable as RPCs" has the full privilege-model reasoning for each new `SECURITY DEFINER`/`SECURITY INVOKER` function — worth independent scrutiny per the Supabase security checklist, since this schema previously had zero `SECURITY DEFINER` functions reachable directly by an end user and now has one (`create_organization_atomic`).
- **7 new/extended e2e spec files**, all against the isolated project: `feedback-and-card-integrity`, `public-submission-safety`, `feedback-pagination`, `analytics-row-cap`, `organization-onboarding`, `tenant-isolation`, `redirect-safety`. Plus 29 new `lib/safe-redirect.test.ts`, 22 rewritten `lib/sentry-redact.test.ts`, and 7 new `features/analytics/fetch-all-rows.test.ts` unit tests.
- **Documentation corrected, not just appended to.** `SECURITY.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `STATUS.md`, `DECISIONS.md` all updated to describe the current state; stale claims (the admin-client count, "no rate limiting," "no isolated e2e environment," "no tenant-isolation test") were corrected in place rather than left alongside new, contradicting text.

## 4. Verification results (exact, not summarized)

```
npm run typecheck     tsc --noEmit                     — clean, re-run after every commit in this range
npm run lint           eslint                            — clean, re-run after every commit
npm run test            vitest run                        — 82/82 passed (75 pre-existing + 7 new)
npm run test:e2e        playwright test                    — 35/35 passed, against the isolated project
npm run build            next build                         — clean, all 16 routes compile (3 static, 12 dynamic, 1 not-found)
```

Every migration was applied to the isolated project with `supabase db push --db-url`, then `supabase db advisors --db-url` — **no issues reported after any of the 8 migrations**. Migration history (`supabase migration list --db-url`) confirmed in sync with `supabase/migrations/` after each push.

Two genuinely flaky (not code-related) conditions were hit and are worth knowing about, not just silently retried past: a "JWT issued at future" (PostgREST error `PGRST303`) clock-skew condition appeared intermittently against the freshly-created isolated project, self-resolving on retry — `e2e/support/seed.ts`'s `userClient()` now retries once past it; and Playwright's default fully-parallel test distribution runs a spec file's `beforeAll`/`afterAll` once *per worker*, not once per file, which surfaced as a real bug in the test fixtures (not the app) until switched to `beforeEach`/`afterEach` — see `280df00`'s commit message for the full diagnosis.

## 5. Remaining risks / explicitly not addressed

- **CI's e2e secrets** almost certainly still point at the shared dev/production Supabase project, not the new isolated one — round 2 should confirm this got updated (`STATUS.md`).
- **Sentry source-map upload** remains unconfigured (needs a credential, out of scope for this pass) — stack traces in the Sentry dashboard are still minified.
- **The 20-per-5-minutes rate limit and 5-minute alert cooldown are untested against real production traffic patterns** — they're deliberately generous constants, easy to retune, but their correctness under genuine load (as opposed to the synthetic bursts the test suite constructs) is unverified.
- **No QR code generation, org switcher, role-gated authorization, or logo upload UI** — all pre-existing, deliberate MVP-scope decisions, unchanged by this pass (`DECISIONS.md`).

## 6. What was deliberately not done

Per this task's explicit constraints: **no merge to `master`, no deployment, no migration applied to the production database.** All 8 new migrations exist only in `supabase/migrations/` on this branch and on the isolated test project — never on the project `.env.local` points at. If/when this branch is approved:

1. `git push -u origin fix/independent-review-findings`, open a PR against `master`.
2. Apply the 8 new migrations to production with `supabase db push --db-url <production-db-url>` (get the connection string from Supabase project settings — **not** the one in `.env.test.local`), then `supabase db advisors` against production to confirm no issues before or immediately after.
3. Update CI's three e2e repo secrets to the isolated test project's values (not production's) — see § 5.
4. Merge, deploy via Vercel's normal flow.
5. **Rollback plan if a migration causes a problem in production:** the new triggers (`prevent_feedback_content_change`, `prevent_nfc_card_location_change`) and the pagination index are all reversible with a `drop trigger`/`drop index` migration and no data loss. `submit_feedback_atomic` and `create_organization_atomic` are new functions with no prior callers to break — reverting the two application-code commits (`8a9487b`, `1faa370`) that call them, plus a follow-up migration dropping the functions, fully reverts both with no data-loss risk either way (neither migration altered or dropped any existing column/table).

## 7. Where to be especially critical this round

1. **The two `SECURITY DEFINER`/`SECURITY INVOKER` functions** (`DATABASE_SCHEMA.md` § "Database functions callable as RPCs") — this is new privilege-model surface that didn't exist in round 1. Confirm the `EXECUTE` grants are as narrow as claimed, `auth.uid()` is checked correctly in `create_organization_atomic`, and `search_path = ''` actually closes the hijacking vector in both.
2. **The two divergences from the review's suggested fixes** (§ 2) — judge them on their own merits, not just "did the reviewer's original suggestion get implemented."
3. **The isolated-test-project claim itself** — confirm `.env.test.local` is genuinely gitignored and was never committed, and that CI's secrets need the update flagged in § 5/§ 6 rather than assuming it already happened.
4. **Whether the new e2e tests actually test what their names claim** — several (e.g. `public-submission-safety.spec.ts`'s rate-limit test) call the database function directly rather than driving 20 real browser submissions, for speed; confirm that substitution doesn't understate what's actually being verified.
5. **The finding #9 fix's interaction with finding #7's fix** — both `app/dashboard/feedback/page.tsx` and `features/analytics/*.ts` now add a secondary `id` sort key for the same reason; confirm that reasoning is actually sound in both places, not copy-pasted without re-verifying it applies.
