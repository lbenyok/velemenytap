# Review Request — Round 13 (independent review wanted)

**You are being asked for a written report**, not a patch.

## Two things make this round different

**First, the trend stopped improving.** Round 11 found four defects and accepted
the round-10 redesigns; I read that as convergence. Round 12 then found four
more including **two P1s**, both in the Checkout attempt lifecycle, and **one of
them I had created myself in round 11** while fixing a different P1. So:

| Round | Findings | Notes |
|---|---|---|
| 9 | 7 (2 P1) | |
| 10 | 8 (2 P1) | two of round 9's *fixes* were wrong |
| 11 | 4 (1 P1) | round 10's redesigns accepted; the P1 was pre-existing |
| 12 | 4 (2 P1) | one P1 was introduced by round 11's fix |

Four rounds in a row have found a defect in the *previous* round's work. Assume
this round's work contains one too, and go looking for it.

**Second, twelve rounds have reviewed billing and nothing else.** The thing
customers actually touch — the public NFC feedback flow, signup, the dashboard
— has never had a dedicated adversarial review. Billing is not even deployed;
the public flow is. That asymmetry is now the biggest unexamined risk in the
project, and § 4 below is where I would spend the most time.

Read alongside `BILLING_INVARIANTS.md`, `OPERATOR_RECOVERY.md`, `STATUS.md`'s
round-12 entry, `PRODUCT_SPEC.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`,
`DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, `LAUNCH_CHECKLIST.md` and
`BUSINESS_DECISIONS.md`. `REVIEW_REQUEST_ROUND12.md` is the previous handoff.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged.**
**Base:** `master` at `443ea98`. Production runs **migration 17**, with no
Stripe environment variables and none of the billing code.
**Round-12 response range:** `92007ff..a26c3b1` — 3 commits, 20 files,
+1403/−47.
**Two new migrations** (47–48): `20260911100000`, `20260911110000`.

---

## What round 12 found, and what was done

| Finding | Fix |
|---|---|
| **R12-01 (P1)** — a missing local Session pointer was read as proof Stripe had created no Session, so a crash between `create()` and the record left a real open payable Session while the attempt was discarded and the key freed | `checkout_request_state` (`unused`/`sent`), marked **before** the call; a `sent` attempt is never discarded on local state — Stripe is enumerated for an open Session |
| **R12-02 (P1)** — a paid Session's attempt was kept forever (R11-01 stopped reconciliation clearing it), so every later resubscribe returned a stale success URL, and a yearly request got an old monthly Session's | `settlePaidSession`: live subscription → success URL and keep; terminal → release and create a real new Checkout; paid with no subscription → fail closed with an anomaly |
| **R12-03 (P2)** — the webhook ledger recorded duplicates without preventing them | claim-before-apply with a recoverable `applied_at` null/set distinction |
| **R12-04/05/06 (P2)** — three operator procedures that could not be executed | all three made executable |
| qualified ownership gap | the success page now checks the Session's Customer against the persisted one, as the webhook already did |

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **590/590**, 25 files |
| `scripts/verify-local-database.mjs` | **48 checks**, real PostgreSQL 17, all **48 migrations** |
| Isolated Playwright suite | **192/192**, zero skipped |
| Stripe **test-mode lifecycle** | **16/16 phases** |
| `npm run typecheck` / `lint` / `build` | clean |
| Mutation tests | **5/5 caught** (three SQL, two TypeScript) |

Two things from that run worth knowing before you trust the numbers:

- One mutation first came back **NOT CAUGHT**. The mint-branch state reset was
  masked by the release-side reset, so the check proved nothing about it. It
  was re-pointed at the legacy-row path where the mint branch fires alone.
  Assume other checks have the same shape until you have looked.
- The browser suite caught a privilege-matrix omission the **local harness
  could not** — the local list asserts one overload per *named* function, never
  completeness. Third round running that the hosted suite caught something
  every local check missed.

---

## Where to be most critical

### 1. A limit in R12-03 that I know about and did not close

`claim_stripe_webhook_event` does `insert … on conflict do nothing`, then
returns `true` if it inserted, otherwise reads `applied_at` and returns
`applied_at is null`.

Two **concurrent** deliveries of the same event therefore both apply: the
second conflicts, reads a still-null `applied_at`, and proceeds. Only a
duplicate arriving *after* the first has finished is suppressed.

I believe that is acceptable — it is the pre-existing behaviour, not a
regression, and the generation counters plus the reconciliation lease make the
effects safe rather than merely tolerable. But I have not proved it, and the
whole history of this project is comments claiming slightly more than the code
delivers. **Is the concurrent case actually safe, and is the claim as written
("a duplicate of an event that already SUCCEEDED is a genuine no-op") narrow
enough to be true?**

### 2. R12-01's new Stripe path

The fix added a question the app had never asked: *does this customer have an
open Checkout Session?*, answered by enumerating `checkout.sessions.list`.

Deliberately it does **not** try to identify which attempt produced a Session —
unanswerable for one whose id was never written down. When it finds an open
Session it **rebinds** it to the current attempt via `record_checkout_session`
and hands it to the normal reconciliation path.

**Questions.** Is "any open Session for this customer" the right question, or
can it bind a Session that legitimately belongs to something else? Is rebinding
sound given the idempotency key no longer corresponds to that Session — what
breaks on the next retry? The enumeration has a 20-page cap that yields
`unknown` and leaves the attempt pending: is that another permanently-stuck
state of the kind round 10 and 11 both found, and does `OPERATOR_RECOVERY.md`
cover it?

### 3. R12-02's `settlePaidSession`

Releasing a paid attempt once its subscription is terminal is what unblocks
resubscription. **Does it open a duplicate-subscription window?** Consider a
customer who pays, cancels, and immediately resubscribes while webhooks are in
flight. Is `no_payment_required` (a trial) handled correctly on both branches?
And is "paid Session with no subscription" — which now fails closed with an
anomaly — reachable in a way that traps a legitimate customer?

### 4. The customer-facing product, which has never been reviewed (spend time here)

Everything above is billing, which is **not deployed**. What *is* deployed and
reachable by real people has had twelve rounds of no attention:

- **The review-gating rule.** The product's one non-negotiable invariant: the
  Google Review CTA must be equally available for 1★ through 5★, never
  conditioned on rating, sentiment, or anything else. I have tested it; I have
  not had anyone try to *break* it. Is there any path — UI, timing, error
  state, a missing `google_review_url`, a deactivated card — where a low rating
  gets a materially worse path to Google than a high one?
- **The public submission endpoint.** Unauthenticated by design. Validation,
  abuse resistance, the 20-per-card-per-5-minutes limit, what a malicious
  caller can do with a guessed or harvested `public_id`.
- **Tenant isolation as an attacker sees it**, not as the RLS tests assert it.
- **Signup and onboarding**, now that production email is verified working for
  confirmation (see below) — first-run experience, error states, what happens
  when onboarding is abandoned halfway.
- **The dashboard**: anything that leaks across organizations, or that a
  `staff`/`manager` role can reach that it should not.

### 5. Production email — one half verified, one half a missing feature

Measured against the live site this round, with a real external mailbox:

- **Signup confirmation works**, proven end to end: the email arrives from
  `no-reply@velemenytap.hu`, the link carries the `token_hash` shape, clicking
  it returns 200 on **`/onboarding`**, and the account is genuinely confirmed
  in Auth.
- **Password reset lands on a 404.** The link authenticates correctly — a real
  session cookie is set — and then hits `/auth/reset-password`, which **exists
  only on this branch**. So does `/auth/forgot-password`; production's login
  page has no reset entry point at all. Self-service password reset is a
  feature awaiting deploy, not a regression.

I got this wrong when I applied the fixes and said they fixed signup *and*
reset. **Is leaving the recovery template pointed at the not-yet-deployed page
the right call**, given the alternatives (restore the fragment bug, or redirect
to `/dashboard` where there is no password-change UI at all)?

### 6. The rollout

48 migrations; production on 17; `DEPLOYMENT.md` § 7 splits 18→48 into
**29 expand + 2 enforce**. The safety argument for the signature-changing ones
rests entirely on none of them having ever been deployed. Round 12 judged this
sound *conditional on production still being at 17*, which it could not verify.
**Is the split still right after migrations 47–48, and is there any ordering in
which an intermediate state breaks the currently-deployed code?**

### 7. Tests that agree with the implementation

Fifth round asking. Which of the round-12 assertions restate what the code does
rather than what the product requires?

---

## Known-unverified, deliberately

- **R10-02's own scenario has never been produced against real Stripe** — a
  `complete` Session with an unresolved payment needs an asynchronous payment
  method, and cards in test mode complete already-paid.
- **The app sends no `payment_method_types`**, so which methods customers see
  is a Stripe account setting this repository cannot establish.
- **No live-mode Stripe transaction has ever been made.**
- **The two new migrations are applied only to the isolated project.**
- **Invoicing compliance remains an open question** — `BUSINESS_DECISIONS.md`
  § 2. Please do not resolve it by assumption.
- Standing ledger point: this repository can verify its own source, SQL and
  local migrations. Any claim about a **Stripe, Supabase or Vercel setting** is
  reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the seven sections above — **including rejections**.
3. For § 4, treat the public flow as the product it is rather than as a
   footnote to billing: a launch-blocking defect there matters more than
   anything in the checkout coordinator, because it is live and billing is not.
4. Anything asserted in the docs, migration headers or code comments that the
   code does not support.
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
