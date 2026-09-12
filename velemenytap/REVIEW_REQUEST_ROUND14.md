# Review Request — Round 14 (independent review wanted)

**You are being asked for a written report**, not a patch.

## Read this first: round 13 could not see the code

Round 13's report was mostly a request for source, because the commit under
review was not reachable from the reviewing checkout. Everything it concluded
was therefore reasoned from my own request document — which means **six of
round 13's seven sections are still unanswered**, and they are repeated below
rather than dropped.

Everything through **`78f4b8e`** is now pushed to
`origin/feature/billing-subscriptions` (PR #4). If you cannot read a file, say
so and stop rather than reasoning from this document — a report that agrees
with my summary of my own work is worth nothing to me.

## The trend, extended

| Round | Findings | Notes |
|---|---|---|
| 9 | 7 (2 P1) | |
| 10 | 8 (2 P1) | two of round 9's *fixes* were wrong |
| 11 | 4 (1 P1) | round 10's redesigns accepted; the P1 was pre-existing |
| 12 | 4 (2 P1) | one P1 was introduced by round 11's fix |
| 13 | 1 | source unreachable; the one finding is disputed — see § 6 |
| 14 | ? | **the work under review is mostly my own, unprompted** |

Five rounds in a row found a defect in the previous round's work. Round 13 is
not evidence that stopped; it is evidence that a reviewer without source
produces one finding.

Read alongside `BILLING_INVARIANTS.md`, `OPERATOR_RECOVERY.md`, `STATUS.md`,
`PRODUCT_SPEC.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, `DECISIONS.md`,
`TEST_PLAN.md`, `DEPLOYMENT.md`, `LAUNCH_CHECKLIST.md` and
`BUSINESS_DECISIONS.md`. `REVIEW_REQUEST_ROUND13.md` is the previous handoff.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged.**
**Base:** `master` at `443ea98`. Production runs **migration 17**, with no
Stripe environment variables and none of the billing code.
**New since round 13:** `609bc67..78f4b8e` — 2 commits, 9 files, +391/−48.
**No new migrations.** Still 48; no SQL changed in either commit.

---

## What is actually new, and why it is unusual

Round 13 was asked to spend its time on the **customer-facing product**, which
twelve rounds of billing review had never touched. It could not, so **I did it
myself** — an adversarial pass over the public NFC feedback flow, with no
report telling me where to look. That is the work under review.

Self-review is the weakest evidence in this project's history. Round 11 exists
because my own audit method was structurally incapable of finding R11-01.
Please treat this section as the likeliest place for a defect, not the least.

### What I found, and what I changed

**The review-gating invariant itself holds.** All five ratings reach the same
CTA through the same branch. The CTA is now a single extracted component that
takes no rating parameter, so there is no longer a parameter through which a
rating could reach it.

**F1 — the CTA existed only on the success screen.** Every *failed* submission
silently removed the customer's route to Google. Two of the four failure paths
are not the customer doing anything wrong:

- `duplicate` — they already submitted on this card within five minutes.
  Re-tapping a card is exactly what someone does when they lost the
  confirmation screen and wanted the Google button; that was the one path that
  refused to give it to them.
- `rate_limited` — the card is busy. Their feedback was not recorded, which is
  no reason to take away their route to Google.

`inactive` (the business switched this card off) and `failed` (unknown error,
retrying is the right next action) deliberately still do **not** offer it.

The error state now carries a `code` rather than a bare Hungarian message, so
the decision is made on the reason rather than by matching prose.

**F2 — the test proved the guard, not the requirement.** The duplicate test
asserted that the rejection *fired* and never asked what the customer was left
with. That is why F1 survived. Both blameless paths are now asserted.

**F3 — a missing `google_review_url` was reported passively.** An *active*
location with no Google destination is the quietest failure this product has:
cards work, submissions succeed, the inbox fills, every dashboard number looks
healthy, and not one customer is ever offered the review. It showed as muted
grey "Nincs beállítva" in a table column, indistinguishable from a blank
address beside it. It is now named in a warning on arrival at Locations and
marked with an icon in its own row. Inactive locations are deliberately
excluded.

Nothing on the public page changed for the missing-URL case: a confirmation
screen with no CTA is already correct when there is no destination, and
fabricating a Google URL is forbidden.

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **590/590**, 25 files |
| Isolated Playwright suite | **198/198**, zero failed, **zero skipped** — production build, CI's exact `workers: 1, retries: 1` |
| `npm run typecheck` / `lint` / `build` | clean |
| Mutation tests (this round) | **7/7 caught** — 4 for F1/F2, 3 for F3 |
| `scripts/verify-local-database.mjs` | **48 checks**, real PostgreSQL 17 — last run at round 12; no SQL changed since |
| Stripe test-mode lifecycle | **16/16 phases** — round 12; no billing code changed since |

Three things about that run you should know before trusting any of it:

- **Two full-suite runs were discarded rather than reported.** A production
  build bakes `NEXT_PUBLIC_*` at build time, so a suite run against a build
  made with the wrong env proves nothing; a second run had `CI=1` without
  `SUPABASE_DB_URL`, which failed 5 tests and stranded 57. Only the third run
  is quoted. This is the same class as round 10's discovery that
  `SUPABASE_DB_URL` was never propagated and **45 tests had been silently
  skipping** — a green suite that was not running what it claimed.
- **One mutation result is the reason to believe the new tests at all**:
  restoring the F1 defect failed both new assertions while **all five rating
  tests stayed green**. Had those gone red too, the new assertions would have
  been redundant with the old ones and proved nothing.
- **One mutation caught a nearly-vacuous assertion.** Reverting the location
  badge to its old muted span was caught *only* by the icon assertion —
  asserting the wording would have passed against the original defect, because
  the passive version said exactly the same words. Assume other assertions in
  this repository have that shape until you have looked.

---

## Two things I found while writing this document, both unfixed

Neither is in the commits above. I found them checking my own claims for this
handoff, and they are the most concrete things in this round.

### A. Production's `/api/health` is behind auth, so the deploy guard cannot pass

Measured just now, not inferred:

```
$ curl -sI https://veleminytap.vercel.app/api/health
HTTP/1.1 307 Temporary Redirect
Location: /login?next=%2Fapi%2Fhealth
$ curl -s  https://veleminytap.vercel.app/api/health
Redirecting...
```

On `master`, `proxy.ts`'s `PUBLIC_PATHS` does **not** include `/api/health`
(this branch adds it). So:

- `DEPLOYMENT.md`'s post-deploy step 1 — *"expect `"ok":true` and `commitSha`
  matching"* — cannot pass against production as deployed.
- `verify-production-deployment` in `ci.yml` uses `curl -fsS` with **no `-L`**.
  A 307 is not a `-f` failure, so it receives the body `Redirecting...`, every
  `JSON.parse` fails, all three checks read empty, and the job polls for its
  full 300-second deadline and then fails — on every push to `master`.

That job exists because of a real incident in which deployments silently
stopped being created. `TEST_PLAN.md` already lists as a known gap that it
*"has not yet had a real failure to prove it actually catches the failure mode
it's for"*. It appears the honest status is worse than that: it cannot succeed.

**Questions.** Is that reading of `curl -fsS` on a 307 right? Is exposing
`/api/health` unauthenticated (what this branch does) correct, or does it leak
something — it reports `commitSha` and `environment`? And is there any other
check in this repository that reports healthy while measuring something it
cannot actually reach?

### B. A rename that the repository claims happened, and the live site contradicts

Commit `08f765f` states: *"Renamed the actual Vercel project ... the live URL
is now `velemenytap.vercel.app`"*, and *"Updated every remaining code/doc
reference: both root-level GitHub Actions workflows,
`scripts/rollout-environments.json`, `README.md`, `DEPLOYMENT.md`..."*.

Today, `https://velemenytap.vercel.app/api/health` returns **404**, while
`https://veleminytap.vercel.app` serves production. And the old spelling is
still present in, among others, `.github/workflows/ci.yml`,
`.github/workflows/reconcile-billing-sweep.yml`,
`scripts/rollout-environments.json`, `scripts/rollout.test.ts`, `README.md`
and six places in `DEPLOYMENT.md`.

The git-visible half of that commit is real: the repo subdirectory *was*
renamed `veleminytap/` → `velemenytap/`, and `master` still has the old
spelling. Which raises the coupling: **Vercel's Root Directory setting must
change in the same window as this merge**, or the production build fails
immediately with `Couldn't find any pages or app directory`. `DEPLOYMENT.md`
line 17 already says Root Directory should be `velemenytap` — but if it were
set that way today, `master` could not build, and it does.

**Questions.** Is the Root-Directory change actually in the launch checklist as
a step, and does anything sequence it against the merge? Are the surviving
`veleminytap` fallbacks in the two workflows and
`scripts/rollout-environments.json` correct-because-current, or stale? And
`scripts/rollout.test.ts` asserts the old spelling — is that a test encoding
the environment, or a test agreeing with the implementation?

---

## Where to be most critical

### 1. The line I drew between failure paths (new, and the most arguable thing here)

`duplicate` and `rate_limited` keep the Google CTA; `inactive` and `failed` do
not. That line is my judgement, and it is the one new product rule in this
round.

**Questions.** Is it defensible, or is it four cases where two would do? The
product's one non-negotiable rule is that the CTA is never conditioned on
rating, sentiment or analysis — it says nothing about error class. **Is
conditioning on error class a disguised form of gating?** I argue no: the CTA
was lost identically for 1★ and 5★, and each of the four codes is
rating-independent by construction. But a rate limit is *more likely* to be hit
on a busy card, and a card is more likely to be deactivated after a bad
experience — is there any path where the error class correlates with rating
strongly enough that this becomes gating in effect?

And the inverse: **should `inactive` and `failed` offer it after all?** A
customer at a counter with a switched-off card still has an opinion. My
reasoning is that the business has deliberately turned that card off, and that
sending someone to Google from an error screen they should be retrying is
wrong. Push back if that is thin.

### 2. The public page now receives the Google URL directly

`app/r/[publicId]/page.tsx` passes `card.googleReviewUrl` into the client
component, because on an error path there is no action result to carry it. It
is validated through `safeGoogleReviewUrl` on both write and render.

**Questions.** Does handing it to the client component ahead of submission
change anything an attacker cares about — it is already public on the success
path, but is there a case where a URL is now exposed for a card or location
state that previously would never have rendered it? Is the guard's allowlist
(HTTPS, exact Google hosts, rejecting `url`/`redirect`/`next`/`fallback`
params) actually sufficient, or is there a Google-hosted open redirect it
admits?

### 3. The duplicate path specifically

The duplicate guard is a card-scoped, HttpOnly, five-minute cookie. It now
leads to a screen offering the Google CTA.

**Questions.** Is there anything a caller gains by deliberately tripping it?
Does offering the CTA there create any incentive or flow that could be read as
steering — e.g. a customer who submitted 1★ and re-taps now sees the CTA
*sooner* than one who submitted 5★ and did not re-tap? Is the cookie's `path`
scoping right, and does it interact with the rate limit in any way I have
missed?

### 4. The locations warning (F3)

**Questions.** Is excluding inactive locations right, or does it hide a real
misconfiguration — an inactive location with active cards, if that is even
reachable? Should the warning also appear on the dashboard overview, where an
owner actually spends time, rather than only on a page visited during setup?
Is a location with a Google URL that is *stored but invalid* possible (the
write path normalises through the guard, but legacy rows and direct database
writes do not), and would it show as "Beállítva" while customers get nothing?

### 5. Everything in the customer-facing product I did *not* review

I reviewed the public feedback flow. I did not adversarially review:

- **Signup and onboarding** — first-run experience, error states, an
  onboarding abandoned halfway.
- **The dashboard** — anything that leaks across organizations, or that a
  `staff`/`manager` role can reach that it should not.
- **Tenant isolation as an attacker sees it**, rather than as the RLS tests
  assert it.
- **The public submission endpoint under abuse** — validation, the
  20-per-card-per-5-minutes limit, what a malicious caller does with a guessed
  or harvested `public_id`.

Billing is not deployed; all of this is.

### 6. Round 13's one finding, which I dispute

Round 13 called the production password-reset 404 a **P1 launch blocker** and
"not a safe intermediate state". The 404 is real and I reported it. What I
dispute is reachability, and the evidence is checkable: `master` contains only
`app/auth/confirm` and `app/auth/auth-code-error` — no `reset-password`, no
`forgot-password` — its login form renders no reset link, and the live
`/login` HTML contains none. There is no customer-reachable way to trigger a
recovery email today; the only way to send one is a deliberate API call, which
is what my verification test did.

Both alternatives the report offered are worse: `{{ .ConfirmationURL }}`
reinstates the URL-fragment bug this branch exists to fix, and `/dashboard`
logs a user in with no password-change UI on `master` at all — and both would
need undoing at deploy, a must-remember step whose omission breaks recovery
*permanently* rather than temporarily.

**Is that reasoning right?** Recorded as a judgement call in
`LAUNCH_CHECKLIST.md` § 1, not as settled. Disagreement is welcome, but please
check `master` rather than accepting my description of it.

### 7–11. Still unanswered from round 13

These were never reviewed against source. They are unchanged and still open:

- **The concurrent-webhook limit I know about and did not close.**
  `claim_stripe_webhook_event` inserts `on conflict do nothing`, then returns
  `applied_at is null`. Two *concurrent* deliveries of the same event therefore
  both apply. I believe the generation counters and the reconciliation lease
  make that safe rather than merely tolerable — **I have not proved it**, and
  is the claim as written ("a duplicate of an event that already SUCCEEDED is
  a genuine no-op") narrow enough to be true?
- **R12-01's new Stripe path.** Is "any open Session for this customer" the
  right question, or can it bind a Session belonging to something else? Is
  rebinding sound when the idempotency key no longer corresponds to that
  Session? The 20-page enumeration cap yields `unknown` and leaves the attempt
  pending — is that another permanently-stuck state, and does
  `OPERATOR_RECOVERY.md` cover it?
- **R12-02's `settlePaidSession`.** Does releasing a paid attempt once its
  subscription is terminal open a duplicate-subscription window — a customer
  who pays, cancels and immediately resubscribes while webhooks are in flight?
  Is `no_payment_required` (a trial) handled on both branches? Is "paid Session
  with no subscription" reachable in a way that traps a legitimate customer?
- **The rollout.** 48 migrations; production on 17; `DEPLOYMENT.md` § 7 splits
  18→48 into **29 expand + 2 enforce**. The safety argument for the
  signature-changing ones rests entirely on none of them having been deployed.
  Is the split right, and is there any ordering in which an intermediate state
  breaks the currently-deployed code?
- **Tests that agree with the implementation.** Sixth round asking. Which
  assertions restate what the code does rather than what the product requires?

---

## Known-unverified, deliberately

- **R10-02's own scenario has never been produced against real Stripe** — a
  `complete` Session with an unresolved payment needs an asynchronous payment
  method, and cards in test mode complete already-paid.
- **The app sends no `payment_method_types`**, so which methods customers see
  is a Stripe account setting this repository cannot establish.
- **No live-mode Stripe transaction has ever been made.**
- **Migration replay from a genuinely clean database has never been performed**
  — no Docker, no disposable cloud project available here. Left open rather
  than approximated: an embedded Postgres would not replicate Supabase's own
  `auth` schema, extensions and roles, so a pass there would not prove what
  replay is for.
- **Invoicing compliance remains an open question** — `BUSINESS_DECISIONS.md`
  § 2. Please do not resolve it by assumption.
- Standing ledger point: this repository can verify its own source, SQL and
  local migrations. Any claim about a **Stripe, Supabase or Vercel setting** is
  reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the sections above — **including rejections**. § 1 is
   the one I most want argued with.
3. Treat the public flow as the product it is rather than as a footnote to
   billing: a launch-blocking defect there matters more than anything in the
   checkout coordinator, because it is live and billing is not.
4. Anything asserted in the docs, migration headers or code comments that the
   code does not support. That specific failure — a comment stating a rule the
   code does not enforce — has appeared in every round so far.
5. The riskiest remaining thing before this takes real money.

If the honest answer to a section is "no finding", say so plainly — a
manufactured finding costs more than a quiet section, and round 11's judgement
that round 10's redesigns should be **retained** was as useful as any of its
four findings.

You will not have credentials for the isolated Supabase project, Stripe test
mode, or a mailbox. You can review the code, SQL, migrations and reasoning; any
confirmation of the real-Stripe, browser-suite or email evidence is a read of
my logs, not independent verification. Please say so where it matters rather
than inheriting my numbers.
