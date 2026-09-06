# Review Request

**Current, consolidated handoff — read this first.** This file previously went stale (it kept describing round 8's own handoff as current long after later work moved past it — an independent review caught this, since reviewers are always told to read this file first and it claimed to reflect "the current state"). Round 8's own detailed content is preserved, unmodified except for an archival note, at `REVIEW_REQUEST_ROUND8.md`. This document intentionally does not duplicate the detailed round-by-round narrative — that lives in `STATUS.md`, in date order, most recent first.

**Arrived here from a `-- see REVIEW_REQUEST.md` comment in a migration file?** That comment predates this document's current content — see "Historical references from migration comments" below for exactly where the evidence it's pointing at actually lives now.

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
| `1cbe4a9` | A fourth independent review found 3 more issues: an inverted GitHub-Actions-variable-vs-Vercel-env-var instruction in the domain checklist (corrected, with a missing redeployment step added and the Supabase redirect-config step reordered), a false "no migrations applied to production" claim in this document (corrected: migrations 1–17 are in production, 18–23 are pending), and several stale references to this document's own now-nonexistent old §5/§6 sections scattered across `STATUS.md` (corrected — commit-pinned links or `DEPLOYMENT.md` § 7 substituted, as appropriate per claim) | "Fourth onboarding-tour review response — 3 findings" |
| `066639e` | A fifth independent review found 3 more issues: the domain checklist's Supabase redirect allowlist still named a bare origin instead of the application's actual `emailRedirectTo` path (corrected to `https://app.velemenytap.hu/auth/confirm**`, with a real signup round trip required as the final proof), this document's own production-state summary conflated "not all of PR #3" with "still on PR #2" when 6 more real commits (Vercel deployment-repair work, a dashboard restyle) sit on `master` past that merge (corrected to separate database state from application state), and 4 more migration-comment citations of this document had gone untraced in the prior audit (corrected — each mapped to its actual historical commit, no migration rewritten) | "Fifth onboarding-tour review response — 3 findings" |
| *(commit that introduced this row — resolve with `git blame`)* | A sixth independent review found 2 more documentation-only issues: this history table's own row for `1cbe4a9` still said "this round's commit — see current head" after `066639e` had already superseded it (corrected — filled in explicitly, and this row added), and `STATUS.md`'s claim that `/api/health` is "the one thing that could prove the exact live commit" overstated it — Vercel's own dashboard/deployment metadata can already identify the deployed commit manually, `/api/health` only adds *automated* verification once it ships (corrected) | "Sixth onboarding-tour review response — 2 findings" |

*A commit can never quote its own final SHA inside the change it introduces — committing is what fixes that hash, so any value written in advance would already be wrong. That's a structural fact about every row above too, not just this one; each earlier row's SHA simply became knowable, and got filled in, once a later commit existed to record it (the `1cbe4a9` row above sat unresolved the same way, under a different, worse placeholder — "see current head" — that went stale the moment a newer commit landed, which is the exact defect this footnote's wording is meant not to repeat). `git blame` on this exact line always resolves it correctly regardless of what happens to the rest of the file afterward: it names the commit that introduced this specific line, not whatever the file's current HEAD happens to be — so, unlike the old wording, it never goes stale even if this row is never manually updated at all.*

None of these findings were rejected across any round. Full reasoning, exact fixes, and exact verification output for each are in `STATUS.md` — this document is a map to that, not a copy of it.

## Current state

Verify directly rather than trusting this snapshot — it will drift the same way round 8's own numbers did:

- **23 migrations total.**
- **Unit tests**: 245 (`npm run test`).
- **e2e tests**: 135 across 17 spec files (`npm run test:e2e`, or `npx playwright test --list`).
- **Production database**: migrations 1–17 applied (merged with PR #2, confirmed in `STATUS.md`'s "Merged to production (2026-09-05)" entry). Migrations 18–23 exist only on this branch, applied only to the isolated test project, pending production rollout.
- **Production application**: documented as the `master` line through `443ea98` — PR #2's merge (`4f984e6`), the Vercel Git-integration/Root-Directory recovery that followed it (`a836673`..`36958d8`), and the dashboard visual restyle that shipped directly to `master` afterward (`443ea98` itself, `git log --oneline 4f984e6..443ea98`). This is what the repository's own history says should be live, not an independently re-confirmed live check today. This repository's own code can't automate that confirmation — `/api/health` doesn't exist in this baseline at all, it's a round-4 addition (`5c74cd0`, R4-01) only present on the still-unmerged branch — but that's a gap in *automated* verification specifically: Vercel's own dashboard and deployment/alias metadata can already identify the exact deployed commit manually today, the same way it did during the "Vercel deployment gap" incident (`STATUS.md`). Confirm the actual live Vercel deployment directly (dashboard or `/api/health` once it ships) before relying on this for a rollout decision.
- **Not in production, any of it**: everything in PR #3 — rounds 4 through 8 of the original security review, the onboarding tour, and every review-response round described in this document. All of it lives only on the still-unmerged `fix/round4-review-findings` branch.

## Domain — read before touching any DNS or Vercel domain settings

Three drafts of this checklist have now needed correction — treat the current one with appropriate scrutiny, not as settled. The first recommended pointing `velemenytap.hu` at this app's Vercel project, which would have disconnected the **Shopify** storefront actually running there. The second (after fixing that) conflated a GitHub Actions repository variable (`PRODUCTION_HEALTH_URL`, read by `.github/workflows/ci.yml`) with a Vercel environment variable, was missing the required production redeployment after a Vercel env var change, and sequenced the Supabase Auth redirect-URL update too late. The third (after fixing those) told the owner to allowlist the bare `https://app.velemenytap.hu` origin in Supabase Auth — Supabase does not treat that as covering every path beneath it, and the application's real `emailRedirectTo` (`features/auth/actions.ts`) sends a full path plus query string, not a bare origin. The current, corrected version is in `STATUS.md`'s **"Fourth onboarding-tour review response"** entry, under "Domain map and safe external-configuration checklist" — step 5 there was corrected in place this round (a targeted fix to one value, not a restructure of the whole checklist, so nothing new was duplicated into the "Fifth" entry above it). In short: the SaaS app should get its own subdomain (`app.velemenytap.hu`), configured alongside the existing Shopify domain, not in place of it — none of it configured yet, and the 13-step order matters (confirm Shopify stays put → add the Vercel subdomain → DNS → verify → Supabase redirect allowlist, exactly `https://app.velemenytap.hu/auth/confirm**` — see `STATUS.md` for why that specific pattern, not the bare origin or a root-level wildcard → `NEXT_PUBLIC_SITE_URL` → **redeploy** → verify every generated-link path, including a real signup-confirmation round trip → the GitHub Actions variable → the rollout manifest → docs → Supabase's primary Site URL last → keep the legacy address as fallback). Do not shorten "Supabase redirect allowlist" back down to a bare domain when summarizing this elsewhere — that's exactly the mistake being corrected.

## Where to focus review

1. Whether the domain checklist is *finally* correct — it's needed correction multiple times now (see "Domain" above for the specific history so far); a fresh independent pass specifically checking every step against the actual GitHub workflow, Vercel variable semantics, Supabase's own redirect-URL matching rules, and every `NEXT_PUBLIC_SITE_URL`/`emailRedirectTo` call site in application code is warranted before trusting it.
2. The new unit tests for `setOnboardingTourStatusAction`'s zero-row disambiguation (`features/onboarding-tour/actions.test.ts`) — confirm they exercise what they claim to and aren't just re-asserting the implementation.
3. Whether any document still makes an unverified "current state" claim, or a historical claim pointing at a mutable document instead of a commit-pinned or archived one — this file went stale once already, and several `STATUS.md` cross-references to it were found stale in the same way this round.

## CI

Check the PR's own live Checks tab rather than a link to one specific run, which goes stale the moment a new commit lands: [github.com/lbenyok/velemenytap/pull/3/checks](https://github.com/lbenyok/velemenytap/pull/3/checks). If citing a specific historical run for a specific past commit, `STATUS.md`'s dated entries name the commit that run belongs to.

## Historical references from migration comments

Four already-applied migration files contain SQL comments naming `REVIEW_REQUEST.md` for a specific finding table or rollout plan. Those migrations are **not** rewritten to fix this — three are already applied to production, and rewriting an applied migration's committed history is exactly the thing this project's own standing discipline prohibits (see `DECISIONS.md`). Instead, here is where each comment's actual evidence now lives, verified by reading the historical file at the commit named, not guessed from the finding number alone:

| Migration | Comment references | Actual location (commit-pinned) |
|---|---|---|
| `20260904131144_enforce_rpc_role_allowlists.sql` | "REVIEW_REQUEST.md's finding table for the reproductions" (R2-07) | [github.com/lbenyok/velemenytap/blob/68cd929/veleminytap/REVIEW_REQUEST.md](https://github.com/lbenyok/velemenytap/blob/68cd929/veleminytap/REVIEW_REQUEST.md) § 1 |
| `20260904194100_enforce_alert_cooldown_trigger.sql` | "REVIEW_REQUEST.md's rollout plan for the exact production sequence" (R3-05) | [github.com/lbenyok/velemenytap/blob/4f984e6/veleminytap/REVIEW_REQUEST.md](https://github.com/lbenyok/velemenytap/blob/4f984e6/veleminytap/REVIEW_REQUEST.md) § 6 |
| `20260904194500_enforce_notification_email_change_trigger.sql` | "REVIEW_REQUEST.md's rollout plan for the exact sequence" (R3-03) | Same commit and section as above — both triggers were part of the same round-3 rollout plan. |
| `20260905193325_server_owned_notification_email_change_budget.sql` | "This file has never been applied to production (see REVIEW_REQUEST.md / DEPLOYMENT.md)" | [github.com/lbenyok/velemenytap/blob/799974d/veleminytap/REVIEW_REQUEST.md](https://github.com/lbenyok/velemenytap/blob/799974d/veleminytap/REVIEW_REQUEST.md) — names this exact file by filename in its own text (the migration was rewritten in place for round 6, which is what this commit's document is the handoff for). |

All four are pre-`REVIEW_REQUEST_ROUND8.md` history — none of that content is preserved in an archive file the way round 8's is, only in git history at the commits above. If a fifth migration is ever found with the same pattern, add it here rather than leaving it to be rediscovered by a future review.

## Not done, still open

- GitHub branch protection / Vercel Deployment Checks (carried forward since round 4).
- `APP_ENV` not yet set in Vercel (carried forward since round 6).
- The domain checklist above — none of its 13 steps performed yet.
- See `STATUS.md`'s "Remaining risks / explicitly not addressed" (round 8 entry) and each later round's own entry for anything added since.
