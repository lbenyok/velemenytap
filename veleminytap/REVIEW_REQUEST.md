# Review Request

**Current, consolidated handoff — read this first.** This file previously went stale (it kept describing round 8's own handoff as current long after later work moved past it — an independent review caught this, since reviewers are always told to read this file first and it claimed to reflect "the current state"). Round 8's own detailed content is preserved, unmodified except for an archival note, at `REVIEW_REQUEST_ROUND8.md`. This document intentionally does not duplicate the detailed round-by-round narrative — that lives in `STATUS.md`, in date order, most recent first.

**Repo**: [github.com/lbenyok/velemenytap](https://github.com/lbenyok/velemenytap).
**Branch**: `fix/round4-review-findings` — **not merged, no production changes of any kind.**
**Base**: `master` at `443ea98`.

**The exact current head is supplied alongside this document whenever it's sent for external review, and is always independently verifiable**: `git rev-parse HEAD`. Nothing below should be read as claiming a fixed commit is permanently "the final one" — treat any SHA in this document as a historical marker for the commit range it describes, not a substitute for checking the actual current head.

## What's happened since round 8

Round 8 (`REVIEW_REQUEST_ROUND8.md`, head `a7aa906`) was the last round of the original round-1–8 security review cycle. Since then, on the same branch:

| Commit(s) | What | Detail in `STATUS.md` |
|---|---|---|
| `9d34c6a`, `ba97a9e` | Built the first-time dashboard onboarding tour (new feature) and rewrote the homepage's copy | "First-time dashboard onboarding tour" |
| `5c67f9c` | Independent review of the above found 6 issues (rollout docs missing 2 migrations, a bulk-`UPDATE` migration backfill, unvalidated/non-atomic Server Action persistence, remaining copy overclaims, thin e2e coverage) — all fixed | "Onboarding-tour review response — 6 findings" |
| `24ed23f` | A further independent review found 5 more issues (a remaining copy overclaim, lost navigation intent on a failed-then-retried save, zero-row Server Action updates always reported as success, inaccurate test/doc claims from the previous round, a repo-wide `veleminytap`→`velemenytap` spelling correction) — all fixed | "Second onboarding-tour review response — 5 findings" |
| `cb5ab3b` | A third independent review found 3 more issues: the previous round's own external-configuration recommendation was unsafe (would have disconnected a live Shopify storefront — corrected), the "membership removed" e2e test didn't exercise the branch it was described as covering (corrected, and backed with real unit tests), and this document itself being stale (resolved by a rewrite) | "Third onboarding-tour review response — 3 findings" |
| *(this round's commit — see current head)* | A fourth independent review found 3 more issues: an inverted GitHub-Actions-variable-vs-Vercel-env-var instruction in the domain checklist (corrected, with a missing redeployment step added and the Supabase redirect-config step reordered), a false "no migrations applied to production" claim in this document (corrected: migrations 1–17 are in production, 18–23 are pending), and several stale references to this document's own now-nonexistent old §5/§6 sections scattered across `STATUS.md` (corrected — commit-pinned links or `DEPLOYMENT.md` § 7 substituted, as appropriate per claim) | "Fourth onboarding-tour review response — 3 findings" |

None of these findings were rejected across any round. Full reasoning, exact fixes, and exact verification output for each are in `STATUS.md` — this document is a map to that, not a copy of it.

## Current state

Verify directly rather than trusting this snapshot — it will drift the same way round 8's own numbers did:

- **23 migrations total. Migrations 1–17 are applied to production** (merged with PR #2, confirmed in `STATUS.md`'s "Merged to production (2026-09-05)" entry). **Migrations 18–23 are applied only to the isolated test project and remain pending production rollout** — this branch has not been merged.
- **Unit tests**: 245 (`npm run test`).
- **e2e tests**: 135 across 17 spec files (`npm run test:e2e`, or `npx playwright test --list`).
- **Production**: still running PR #2's code (rounds 1–3 fixes only, migrations 1–17). Everything else — rounds 4 through 8, the onboarding tour, and every review-response round described in this document — lives only on the still-unmerged `fix/round4-review-findings` branch. Don't assume anything past round 3 is live; verify against `STATUS.md`'s own "Merged to production" entries, not this summary, before relying on it.

## Domain — read before touching any DNS or Vercel domain settings

Two drafts of this checklist have now needed correction — treat the current one with appropriate scrutiny, not as settled. The first recommended pointing `velemenytap.hu` at this app's Vercel project, which would have disconnected the **Shopify** storefront actually running there. The second (after fixing that) still conflated a GitHub Actions repository variable (`PRODUCTION_HEALTH_URL`, read by `.github/workflows/ci.yml`) with a Vercel environment variable, was missing the required production redeployment after a Vercel env var change, and sequenced the Supabase Auth redirect-URL update too late. The current, corrected version is in `STATUS.md`'s **"Fourth onboarding-tour review response"** entry, under "Domain map and safe external-configuration checklist." In short: the SaaS app should get its own subdomain (`app.velemenytap.hu`), configured alongside the existing Shopify domain, not in place of it — none of it configured yet, and the 13-step order matters (confirm Shopify stays put → add the Vercel subdomain → DNS → verify → Supabase redirect allowlist → `NEXT_PUBLIC_SITE_URL` → **redeploy** → verify every generated-link path → the GitHub Actions variable → the rollout manifest → docs → Supabase's primary Site URL last → keep the legacy address as fallback).

## Where to focus review

1. Whether the domain checklist is *finally* correct — it's been wrong twice; a third independent pass specifically checking every step against the actual GitHub workflow, Vercel variable semantics, and every `NEXT_PUBLIC_SITE_URL` call site in application code is warranted before trusting it.
2. The new unit tests for `setOnboardingTourStatusAction`'s zero-row disambiguation (`features/onboarding-tour/actions.test.ts`) — confirm they exercise what they claim to and aren't just re-asserting the implementation.
3. Whether any document still makes an unverified "current state" claim, or a historical claim pointing at a mutable document instead of a commit-pinned or archived one — this file went stale once already, and several `STATUS.md` cross-references to it were found stale in the same way this round.

## CI

Check the PR's own live Checks tab rather than a link to one specific run, which goes stale the moment a new commit lands: [github.com/lbenyok/velemenytap/pull/3/checks](https://github.com/lbenyok/velemenytap/pull/3/checks). If citing a specific historical run for a specific past commit, `STATUS.md`'s dated entries name the commit that run belongs to.

## Not done, still open

- GitHub branch protection / Vercel Deployment Checks (carried forward since round 4).
- `APP_ENV` not yet set in Vercel (carried forward since round 6).
- The domain checklist above — none of its 13 steps performed yet.
- See `STATUS.md`'s "Remaining risks / explicitly not addressed" (round 8 entry) and each later round's own entry for anything added since.
