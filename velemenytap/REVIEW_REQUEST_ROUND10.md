# Review Request — Round 10 (independent review wanted)

**You are being asked for a written report**, not a patch. This is a review *of a
review response*: round 9 found seven defects, all seven were confirmed and fixed, and
what follows is the fix set. The most useful thing you can do is decide whether the
fixes are actually right — several of them replace one invariant with another, and a
wrong replacement is worse than the original bug because it now has tests agreeing
with it.

Read alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`,
`SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, `STATUS.md`,
`LAUNCH_CHECKLIST.md` and `BUSINESS_DECISIONS.md`. `REVIEW_REQUEST_ROUND9.md` is the
previous round's handoff and `STATUS.md`'s round-9 entry is the finding-by-finding
account.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged, nothing
deployed.** Production still runs migration 17 with no Stripe environment variables.
**Base:** `master` at `443ea98`.
**Round-9 response range:** `53b86e8..9b5ccda` — 1 commit, 18 files, +1525/−49.
**Three new migrations**, applied only to the isolated Supabase test project:
`20260909100000`, `20260909110000`, `20260909120000`.

---

## What the round-9 review found, and what was done

All seven confirmed, none rejected. Two P1s:

- **R9-01** — a failed `expire()` left two payable Checkout Sessions. If expiration
  threw and the follow-up retrieval showed a still-open Session (or also failed),
  control fell through to releasing the attempt and the caller created a replacement.
  **Fix:** an attempt is released only once the Session is confirmed to have left the
  `open` state; unknown fails closed.
- **R9-02** — activation and subscription refresh consumed each other's generations.
  One counter pair counted *requests*, not *kinds of work*. **Fix:** activation gets
  its own counter pair, and — so that cannot deadlock — a refresh writing an `active`
  status also sets `activated_at`.

Five P2s: a creation operation lease (R9-03), a legacy-key sentinel replacing an
invented random key (R9-04), two more `now()`-before-lock cases (R9-05), the sweep
returning 500 on real errors (R9-06), and subscription-history pagination (R9-07).

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **572/572**, 26 files |
| `scripts/verify-local-database.mjs` | **34 checks** against real PostgreSQL 17, 39 migrations |
| Isolated Playwright suite | **187/187**, zero failed, zero skipped (20 spec files) |
| `npm run typecheck` / `lint` / `build` | clean |

**Every one of the seven regressions was mutation-tested**: run against the pre-fix
behaviour, where it fails, then against the fix, where it passes.

---

## Where to be most critical

### 1. R9-02's second half is the riskiest thing in this diff

Splitting the counters was structural and I am fairly confident in it. The part I am
**not** confident in is the anti-deadlock half: `write_reconciliation_result` now sets
`activated_at` when it writes an `active` status.

The reasoning was: an `active` subscription means its first invoice was paid, which is
migration `20260907180000`'s own definition of the field ("the first-ever observed
transition to Stripe subscription status `active`"). Without it, an organization whose
`invoice.paid` was never redelivered stays dirty forever with nothing able to satisfy
the activation obligation.

**Questions:** Is that equivalence actually sound — can a Stripe subscription be
`active` without a payment having succeeded (a 100%-off coupon, a manually-created
subscription, a trial that Stripe reports as `active` rather than `trialing`, a
backdated or externally-managed subscription)? `activated_at` is a one-way latch that
permanently ends grandfathering (`features/billing/status.ts`), so a false positive
costs an organization its grace access forever. Is the deadlock I was avoiding real,
or did I trade a livelock for a wrong write?

### 2. R9-01: is "not open" really "not payable"?

The fix treats leaving the `open` state as sufficient to release the attempt and
create a replacement. `expired` is clearly terminal. `complete` I argued is terminal
*for payment purposes* even when `payment_status` is `unpaid`, since the Session
cannot be completed twice.

**Question:** is that true for asynchronous or delayed payment methods, where a
Session can be `complete` while the payment is still resolving? This app configures
card payments only, but the check is about Stripe's states, not this app's
configuration. If a complete-but-unpaid Session can still become paid, the fix is
incomplete in the same shape as the bug it replaces.

### 3. New stuck states introduced by the new leases and caps

Each fix that fails closed can strand an organization. Please look for cases where the
system can no longer make progress on its own:

- The **creation lease** (R9-03) is 150 seconds. A process killed while holding it
  blocks checkout for that long. Is that the only exposure, and is anything needed to
  surface it?
- **Rotation** now requires holding the lease *and* being outside the retry-safe
  window. Can an organization reach a state where nobody can ever rotate?
- The **subscription page cap** (R9-07, 20 pages) and the **customer enumeration cap**
  (20 pages) both fail rather than deciding from a prefix. Round 9 already noted the
  latter needs an operator recovery procedure. Is failing closed still right, and what
  should the operator actually do?

### 4. R9-04's backfill now touches every unresolved row

The corrected backfill stamps `legacy-org-<id>` on **every** row with no
`stripe_customer_id`, not only those with a checkout attempt — because commit
`241572f` resolved the customer *before* claiming an attempt, so an interruption leaves
no attempt at all.

**Question:** is that over-broad? It means a brand-new organization that has never
touched billing gets a creation identity mapping to the *previous* version's key, and
is dated from its own `created_at` (so a recently created one is retry-safe and a
long-standing one is not). I believe both branches are sound, but this changes
first-checkout behaviour for every existing organization and deserves a second look.

### 5. Is the `now()`-before-lock class actually closed this time?

This is the **fifth** round in which an instance was found, and each previous
class-wide search missed the next one. Round 9's two cases were missed because neither
looks wrong at the statement that is wrong — one uses the correct function against the
wrong instant, the other takes the deciding lock implicitly via `UPDATE`.

**Please search independently** rather than trusting my claim, and treat implicit
locks (`UPDATE ... WHERE`, `INSERT ... ON CONFLICT`, trigger bodies, advisory locks
followed by row writes) as candidates.

### 6. What else in the test suite agrees with a bug?

The sharpest thing round 9 surfaced was indirect: a pre-existing browser test asserted
that an activation write advanced `billing_sync_completed` — it had encoded the very
coupling that was the defect. The suite was green partly *because* a test agreed with
the bug. That test is now inverted.

**Question:** are there others? A test whose assertions were written from the
implementation rather than from the requirement is invisible to a green run.

---

## Known-unverified, deliberately

- **No live-mode Stripe transaction has ever been made.** Test mode is verified end to
  end (initial purchase, annual, renewal, failed payment, recovery, cancellation,
  resubscription); live mode shares none of that configuration.
- **Production email is unfixed.** Both faults (no SMTP; templates using
  `{{ .ConfirmationURL }}`, whose fragment a server route cannot read) are fixed and
  verified on the isolated project only.
- **The three new migrations are applied only to the isolated project.**
- **Invoicing compliance is an open question, not a settled fact** — see
  `BUSINESS_DECISIONS.md` § 2. Please do not resolve it by assumption.
- Round 9's ledger point stands and I would keep it: this repository can verify its own
  consistency, not the state of external accounts. Any claim about a Vercel, Supabase
  or Stripe *setting* is reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the six sections above — including **rejections**, and
   including "this fix is wrong" if that is what you conclude. A fix that replaces one
   invariant with a subtly wrong one is the failure mode this round is most exposed to.
3. Anything asserted in the docs or code comments that the code does not support.
4. The riskiest remaining thing before this takes real money.
