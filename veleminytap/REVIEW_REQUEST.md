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
| `5c67f9c` | Independent review of the above found 6 issues (rollout docs missing 2 migrations, a bulk-`UPDATE` migration backfill, unvalidated/non-atomic Server Action persistence, remaining copy overclaims, thin e2e coverage) — all fixed | "Second onboarding-tour review response" |
| `24ed23f` | A further independent review found 5 more issues (a remaining copy overclaim, lost navigation intent on a failed-then-retried save, zero-row Server Action updates always reported as success, inaccurate test/doc claims from the previous round, a repo-wide `veleminytap`→`velemenytap` spelling correction) — all fixed | "Second onboarding-tour review response" (same entry) |
| *(this round's commit — see current head)* | A third independent review found 3 more issues: the previous round's own external-configuration recommendation was unsafe (would have disconnected a live Shopify storefront — corrected, see below), the "membership removed" e2e test didn't exercise the branch it was described as covering (corrected, and backed with real unit tests), and this document itself being stale (resolved by this rewrite) | "Third onboarding-tour review response" |

None of these findings were rejected across any round. Full reasoning, exact fixes, and exact verification output for each are in `STATUS.md` — this document is a map to that, not a copy of it.

## Current state

Verify directly rather than trusting this snapshot — it will drift the same way round 8's own numbers did:

- **23 migrations**, none applied to production (`supabase migration list` against the isolated test project).
- **Unit tests**: 245 (`npm run test`).
- **e2e tests**: 135 across 17 spec files (`npm run test:e2e`, or `npx playwright test --list`).
- **Production**: still the pre-existing Vercel deployment from earlier rounds; nothing in this branch has been merged or deployed.

## Domain — read before touching any DNS or Vercel domain settings

An earlier draft of this round's own external-configuration advice was itself wrong and potentially destructive: it recommended pointing `velemenytap.hu` at this app's Vercel project. An independent live check found `velemenytap.hu` already serves a **Shopify** storefront (password-protected, presumably selling the physical NFC cards) — pointing it at Vercel instead would have disconnected that store. **Do not do this.** The corrected domain map and a safe, ordered external-configuration checklist are in `STATUS.md`'s "Third onboarding-tour review response" entry, under "Domain map and safe external-configuration checklist." In short: the SaaS app should get its own subdomain (`app.velemenytap.hu`), configured alongside the existing Shopify domain, not in place of it — and none of that has been configured yet.

## Where to focus review

1. Whether the domain-map correction above is itself now safe and complete — this was a real near-miss, worth a second set of eyes specifically on the ordering (DNS/Vercel steps before any repo-text or rollout-manifest change).
2. The new unit tests for `setOnboardingTourStatusAction`'s zero-row disambiguation (`features/onboarding-tour/actions.test.ts`) — confirm they exercise what they claim to and aren't just re-asserting the implementation.
3. Whether any other document still makes a claim similar to this file's own former staleness — a claim of "current state" that isn't re-verified each time it's read.

## CI

Check the PR's own live Checks tab rather than a link to one specific run, which goes stale the moment a new commit lands: [github.com/lbenyok/velemenytap/pull/3/checks](https://github.com/lbenyok/velemenytap/pull/3/checks). If citing a specific historical run for a specific past commit, `STATUS.md`'s dated entries name the commit that run belongs to.

## Not done, still open

- GitHub branch protection / Vercel Deployment Checks (carried forward since round 4).
- `APP_ENV` not yet set in Vercel (carried forward since round 6).
- The domain checklist above — none of its 10 steps performed yet.
- See `STATUS.md`'s "Remaining risks / explicitly not addressed" (round 8 entry) and each later round's own entry for anything added since.
