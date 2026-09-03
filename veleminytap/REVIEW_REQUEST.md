# Review Request

Written for an external reviewer (ChatGPT, per the working agreement) picking this up cold. Start with `PRODUCT_SPEC.md` for what this is, `ARCHITECTURE.md` for how it's built, and `DECISIONS.md` for the reasoning behind anything that looks like a gap.

## What changed this round

A prior session built the MVP (auth → orgs → locations → NFC cards → public feedback page → inbox → email alerts → analytics → production deploy on Vercel). This round closed the gap between that MVP and a fuller product spec:

1. `feedback.priority` (generated column) + UI surfacing (badge, row highlighting, filter-ready index).
2. NFC card filter on the feedback inbox.
3. Overview page: Today / This week / Unresolved-negative stats, rating-distribution bar.
4. A Settings page (business name, notification email, logo URL) and `notification_email`-based alert routing.
5. A `profiles` table, auto-populated on signup (not yet read anywhere).
6. Cookie-based duplicate-submission protection on the public feedback endpoint.
7. Vitest unit tests for the pure aggregation logic and the feedback validation schema (including a schema-level review-gating check).
8. This documentation suite.

Full detail in `STATUS.md`. Exact diff: `git log` from `c99bbca` (the last commit before this round) forward.

## What to scrutinize hardest

- **RLS correctness** — `DATABASE_SCHEMA.md` § Row Level Security and § Data-integrity triggers. The claim is that every tenant-owned table is protected by `private.is_org_member(organization_id)` and that the denormalized `organization_id`/`location_id` columns can't drift from their true parent because of trigger-level validation. Worth independently checking whether any policy or trigger has a gap (e.g. a missing `WITH CHECK`, a column an `UPDATE` policy doesn't cover).
- **The one deliberate RLS bypass** — `SECURITY.md` § "The one deliberate RLS bypass". Public feedback submission uses the secret-key admin client because there's no authenticated user to check `auth.uid()` against. Worth confirming the server-side re-validation (card existence, active status, org/location re-derivation from the card rather than client input) is actually sufficient to make that bypass safe, and that it's truly the *only* place the admin client is used outside notification lookups.
- **The Google Review non-gating guarantee** — `PRODUCT_SPEC.md` § "The one rule that overrides everything else", verified manually this session across ratings 1 and 5 (`TEST_PLAN.md`) plus a schema-level unit test (`features/feedback/schema.test.ts`). Worth checking `app/r/[publicId]/page.tsx` and whatever renders the CTA for any code path — however unlikely — that could condition it on rating, sentiment, or resolution status.
- **Anti-spam posture** — `SECURITY.md` § "Why no IP-based / Redis-backed rate limiting (yet)". This is a documented tradeoff, not an oversight, but worth a second opinion on whether the cookie-only approach is actually adequate for a public, unauthenticated write endpoint before more businesses depend on it.

## Known gaps (see `STATUS.md` for full list)

No Sentry yet, no e2e/Playwright automation yet, no CI pipeline, no automated tenant-isolation test, no rate limiting beyond the duplicate-tap cookie. Each has a documented reason in `DECISIONS.md`/`SECURITY.md`/`TEST_PLAN.md` for why it wasn't done this round rather than being silently skipped.

## Specific questions for the reviewer

1. Is the RLS + trigger combination in `DATABASE_SCHEMA.md` actually sufficient to prevent cross-tenant access, or is there a scenario (e.g. a user who is a member of two organizations) that isn't covered?
2. Is the `notification_email`-overrides-member-alerts behavior (`DECISIONS.md`) the right default, or should it be additive instead?
3. Given no CI exists yet, is it more valuable to stand up CI first (running the existing Vitest suite) or to write the e2e suite first (with no CI to run it in until later)? `TEST_PLAN.md` currently argues for CI first — worth a second opinion.
4. Anything in `SECURITY.md`'s threat model that looks incomplete for a public-facing, unauthenticated write endpoint accepting free-text input from anyone with the URL.

## How to verify locally

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run dev   # then exercise /r/{a real nfc_cards.public_id} manually
```

Latest commit hash at the time of this review request: see `git log -1` — this document is written before this round's commits are made, so check `STATUS.md`'s "Not yet committed" note if the hash below looks stale. (Will be updated to the actual hash once committed; see the final message of this session for the authoritative value.)
