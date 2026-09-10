# Billing invariants

The round-9 and round-10 reviews both found the same shape of defect: a rule was
stated in a comment, and the code enforced something weaker. Several fixes then
replaced one invariant with another that was subtly wrong. This file is the
short, authoritative statement of what billing must guarantee, so a change can
be checked against a requirement instead of against the current implementation.

Written after round 10. Each invariant names where it is enforced and which
review finding it answers.

---

## The two facts that must never be conflated

Most of the activation defects come from one confusion. There are **two
different facts** about an organization, and they are not the same fact:

| | Question | Column | Lifetime |
|---|---|---|---|
| **Current entitlement** | Should the dashboard open *right now*? | `status` + `stripe_subscription_id` | changes constantly |
| **Payment history** | Has this organization *ever* actually paid? | `activated_at` | one-way latch, permanent |

`activated_at` is not "is the subscription good". It is the fact that ends
prepayment grace **forever**: once set, a grandfathered or trialing
organization can never fall back to that grant again
(`features/billing/status.ts`). A wrong `activated_at` is unrecoverable
without manual repair, so it may only ever be written from evidence that a
payment genuinely settled.

---

## I1 — Activation requires verified payment evidence, never a status

`activated_at` may only be set from a **signed `invoice.paid` event** whose
invoice is `paid`, whose Customer matches the organization's persisted
Customer, and whose subscription carries an approved VéleményTap Price.

That is the product's payment policy, and it is unchanged from the original
`invoice.paid` path — deliberately, so that fixing recovery does not quietly
redefine "ever paid". In particular a **zero-total paid invoice is still an
activation** (a 100%-off coupon settles the invoice; Stripe reports it
`paid`), because the older path already accepted it and narrowing it would
revoke access from organizations that legitimately have it.

A Stripe subscription **`status = 'active'` is NOT evidence of payment.**
Stripe documents `collection_method=send_invoice` subscriptions as starting
active while the first invoice is unpaid, and a subscription can also be
created active out-of-band from the Dashboard or API.

*Enforced:* `request_billing_activation` is the only writer of `activated_at`,
and it requires evidence. `write_reconciliation_result` never derives it.
*Answers:* R10-01. *Reverses:* round 9's anti-deadlock half of R9-02.

## I2 — Activation is atomic with its evidence

The verified payment fact and the durable record of it are written in **one
statement**. There is no window in which an activation is "requested" but not
yet performed, so there is nothing to interrupt, and nothing that a later
worker has to reconstruct from a Stripe state that may since have changed.

This is strictly stronger than "a pending activation can be finished later":
a pending activation cannot exist.

*Enforced:* `request_billing_activation(organization_id, evidence)` latches
`activated_at`, stores the evidence, and advances both activation counters in
a single `UPDATE`. `write_activation` is gone — it was the interruptible half.
*Answers:* R10-03. The paid-then-canceled case needs no invoice redelivery and
no resubscription, because the fact was never in two pieces.

## I3 — A replacement Checkout requires proof the old one cannot collect

An organization's Checkout attempt may only be released — which is what
authorizes creating a second, separately payable Session — once the previous
Session is **confirmed unable to take money**.

`status = 'expired'` proves that. `status != 'open'` does **not**: Stripe
documents `complete` while a payment is still processing, and a
`complete`/`unpaid` Session's payment can still succeed afterwards.

So for a completed Session whose payment is unresolved, the decision is made
on the **subscription it created**: only a subscription in a terminal state
(`canceled` or `incomplete_expired`) releases the attempt. Any live or
recoverable status — `incomplete`, `past_due`, `unpaid`, `active`,
`trialing`, `paused` — keeps the obligation pending, and so does any failure
to read it.

**A completed Session carrying NO subscription reference also keeps the
obligation pending.** An earlier draft of this file listed "none ever created"
as a release condition, which the code has never done and should not: the code
cannot establish that no subscription exists, only that it cannot see one, and
that is uncertainty rather than proof (§ I5). It records a
`completed_session_without_subscription` anomaly and routes to
`OPERATOR_RECOVERY.md` § 4.

**One qualification, from the round-11 review.** `incomplete_expired` has the
strongest documented basis — Stripe voids its open invoice and generates no
more. `canceled` is weaker than the phrase "no further money can ever be
collected" suggests: Stripe documents surviving invoice items, final invoices
and open invoices that can still be collected **manually**. Cancellation stops
automatic collection; it does not universally void every financial object. This
implementation inspects the subscription's status and no invoice or payment
object, so treat `canceled` as "this subscription will not charge on its own",
not as a universal proof about an already-processing payment.

*Enforced:* `reconcileExistingSession` in `features/billing/actions.ts`, using
`hasLiveSubscription`'s status set — the same set that already defines "a
second Checkout would risk double-charging".
*Answers:* R10-02. *Reverses:* round 9's "not open means not payable".

## I4 — An idempotency key is a replay only if it was actually sent

Replaying a Stripe `create()` under a frozen idempotency key is safe **only**
if that key was genuinely used in a request that may have reached Stripe. A
key that a migration invented, or that was minted but never sent, deduplicates
nothing — replaying it creates a second object.

So creation identity carries an explicit state, never inferred from its age or
its shape:

| State | Meaning | Recovery path |
|---|---|---|
| `unused` | minted by this app, never sent to Stripe | nothing to recover — create directly |
| `sent` | sent at least once; may have landed | replay inside retention; enumerate outside it |
| `unverified_legacy` | stamped by a migration; an earlier billing version may have created a Customer under some other key | always enumerate |

*Enforced:* `customer_creation_key_state` on `organization_billing`; the app
transitions `unused -> sent` immediately **before** the Stripe call, so a crash
during the call still records that it may have landed.
*Answers:* R10-04. A migration can no longer manufacture a false replay, and no
migration needs to overwrite an identity that is already valid.

## I5 — Uncertainty is a state, not an assumption

Where Stripe cannot supply a guarantee, the system records that it does not
know and stops, rather than picking the convenient interpretation:

- An **empty Customer Search** is never evidence of absence. Search is
  documented as lagging with no stated bound, so it can only produce false
  negatives: a hit proves existence, a miss proves nothing. Only a **completed
  `customers.list` enumeration** over the window the attempt could have created
  in authorizes creation.
- An enumeration that **cannot finish** — API error, or more pages than the cap
  — returns `unknown`, never `absent`, and the attempt stays pending.
- A database lease **cannot revoke a request already in flight at Stripe.** It
  narrows the window; it does not close it. Where a stale worker can still
  create an orphaned Customer, that outcome is **detected and recorded as an
  anomaly** for the operator rather than silently discarded.
- **What this request knows about an external object it created is written
  down before anything that can fail.** The record of a created Customer is
  never sequenced after a step that can throw -- R11-03 was exactly that: the
  winner was resolved first, resolution threw in a legitimate intermediate
  state, and the id of a real Stripe object was lost from the anomaly meant to
  capture it. It is recorded as **unresolved** first and classified as a
  confirmed orphan only once a different winner is actually established;
  inventing the confirmed classification early would be R10-01 in miniature.
- The pre-call fence requires enough lease to cover the Stripe call, using a
  **nominal 60-second budget**. That is a working bound, not an exact worst
  case: it does not model retry backoff or connection overhead on top of three
  20-second HTTP attempts. Do not describe it as a proven maximum lifetime.

*Enforced:* `findExistingCustomer`; the pre-call lease re-check in
`createStripeCustomer`; the `unresolved_customer_creation` and
`orphaned_customer` anomalies on a rejected record.
*Answers:* R10-05. See `OPERATOR_RECOVERY.md` for what an operator does with
each uncertain state.

## I6 — A time-based decision is taken after every lock it depends on

A cooldown, budget, rate limit or lease check must compare against an instant
read **after** the transaction holds every lock that can make it wait —
including locks acquired *implicitly*, by a later `UPDATE`, or by a foreign-key
check on an `INSERT`.

`now()` is transaction-start time and is never correct for such a decision;
`clock_timestamp()` read too early is equally wrong. This class has now been
found in **six** separate rounds, always at a statement that does not look like
a lock.

Lock order, for the application's own paths: **`nfc_cards` -> `locations` ->
`organizations`**, matching `submit_feedback_atomic`'s existing join order.

**Two limits on that claim, both established by the round-11 review rather than
asserted here.** First, it covers the application's own functions; an
administrative `DELETE` on `organizations` takes parent-to-child cascade locks
in the opposite direction and was demonstrated to deadlock against a concurrent
feedback submission (SQLSTATE 40P01). There is no ordinary application path
that deletes an organization, and the *implicit* foreign-key check this
replaced could produce the same cycle — but "deadlock-free" is false as a
universal statement, and administrative deletion needs quiescence or retry
handling. Second, the class is not provably absent: what is true is that every
writer whose decision is a cooldown, budget, rate limit, lease or expiry has
been audited and fixed. A future addition can reintroduce it, and five previous
rounds each declared this closed before the next instance was found.

*Enforced:* `submit_feedback_atomic`, `claim_negative_alert_send`,
`reserve_notification_email_change`, and the billing lease writers.
*Answers:* R10-06, R10-07.

## I7 — Ownership must hold for the whole of the work it authorizes

A worker that pages through Stripe must still own its lease when it writes. A
lease is therefore **renewed between pages**, and a renewal that fails aborts
the traversal immediately rather than continuing work whose result will be
rejected.

A scan that is slower than the lease is not a contention problem that fixes
itself — retrying it reproduces it exactly.

*Enforced:* `reconcileOrganizationBilling`'s pagination loop.
*Answers:* R10-08 (first half).

## I8 — Work that never finishes must become visible

Durable dirty flags guarantee that no work is *lost*. They do not tell anyone
that work is *stuck*. Those are different guarantees and both are required.

An organization that has been dirty for longer than the backlog threshold is
reported by the sweep as an operator-visible failure, separately from ordinary
per-run errors. Ordinary `deferred` contention stays non-fatal.

**What that threshold does and does not mean.** It is an **elapsed-age signal**,
not evidence that any number of sweeps ran and failed: scheduled executions can
be delayed, can be absent, or can never have been configured at all — and an
unconfigured scheduler is precisely a case where nothing would ever be reported.
Do not read "dirty for an hour" as "four sweeps failed".

**An anomaly row is not a notification either.** The backlog query scans
`organization_billing`; it does not scan `private.billing_anomalies`. Orphaned
customers, unresolved creations, missing subscription references and
legacy-activation records are written where an operator can find them, not
pushed anywhere. `OPERATOR_RECOVERY.md` § 5 names who is expected to look and
how often.

*Enforced:* `get_billing_reconciliation_backlog`, surfaced by
`/api/admin/reconcile-billing-sweep`.
*Answers:* R10-08 (second half), and round 9's outstanding "needs an operator
procedure" note.

---

## What this repository can and cannot establish

Unchanged from round 9, and worth repeating because several claims have been
overstated before: this repository can verify its own source, SQL and local
migrations. Any statement about a **Stripe account setting, a Supabase project
setting, Vercel configuration, production migration state, or a real email**
is reported evidence, not something the test suite proves. Those are listed in
`LAUNCH_CHECKLIST.md` and remain owner actions.
