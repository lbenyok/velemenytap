# Review Request — Round 11 (independent review wanted)

**You are being asked for a written report**, not a patch.

This is the third round in a row reviewing the *same* code, and the pattern is
the point. Round 9 found seven defects. Round 10 confirmed all seven findings
were valid but showed **two of round 9's fixes were wrong** — each had replaced
one invariant with a subtly different, false one, and shipped with tests
agreeing with it. Round 10's eight findings are now fixed, and the single most
useful question you can answer is whether *those* fixes are right.

The failure mode this project keeps producing is not "a bug was missed". It is
**a fix that is confidently wrong, verified by a test written from the
implementation rather than from the requirement.** Please hunt for that
specifically.

Read alongside `BILLING_INVARIANTS.md` (new — the requirements written down
once, which is the thing to check the code against), `OPERATOR_RECOVERY.md`
(new), `STATUS.md`'s round-10 entry, `DATABASE_SCHEMA.md`, `DECISIONS.md`,
`TEST_PLAN.md`, `DEPLOYMENT.md`, `LAUNCH_CHECKLIST.md` and
`BUSINESS_DECISIONS.md`. `REVIEW_REQUEST_ROUND10.md` is the previous handoff.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged.**
**Base:** `master` at `443ea98`. Production runs **migration 17** with no Stripe
environment variables.
**Round-10 response range:** `aa87587..6dd54e7` — 3 commits, 27 files,
+3945/−1238.
**Five new migrations** (40–44), applied only to the isolated Supabase test
project: `20260910100000`, `20260910110000`, `20260910120000`,
`20260910130000`, `20260910140000`.

---

## What round 10 found, and what was done

All eight confirmed, none rejected. They reduce to four causes:

| Cause | Findings | Fix |
|---|---|---|
| A live Stripe **status** treated as a historical **payment** | R10-01 (P1), R10-03 | `activated_at` written only from verified `invoice.paid` evidence, stored in a new `activation_evidence` column; activation made **atomic** |
| A **terminal-looking state** treated as one that cannot collect | R10-02 (P1) | a completed Session with unresolved payment releases its attempt only once **the subscription it created** is terminal |
| An idempotency key's **age** treated as proof it was **sent** | R10-04, R10-05 | `customer_creation_key_state` (`unused`/`sent`/`unverified_legacy`) as a recorded fact; a pre-call fence; orphan detection |
| A **time-based decision** made before a lock it waits on | R10-06, R10-07 | organization row locked explicitly, in a documented order, before the clock read |
| **Work not lost** reported as **work done** | R10-08 | lease renewed between pages; a backlog query surfaces stuck organizations |

---

## The most informative thing that happened this round

While fixing R10-01, migration 40 had to **re-create**
`claim_reconciliation_lease` because its return type changed. Re-creating it
silently discarded three behaviours earlier rounds had added to the version
being replaced — the crash-gap dirty marking, the refused contender's dirty
marking, and the 300-second lease cap. None was related to the change being
made.

**Everything static passed with the regression present:** typecheck, lint,
578 unit tests, and a 41-check harness against real PostgreSQL. Three hosted
browser tests failed immediately.

Treat that as calibration for how much the green numbers below are worth. It
also means the highest-yield question in this review is not "is the new logic
correct" but **"what did the new logic quietly stop doing?"**

I checked the other two re-created functions myself, by extracting every
`UPDATE ... SET` column from the old and new bodies:

- `write_reconciliation_result` no longer writes `activated_at` or
  `activation_completed` — **both intentional** (R10-01).
- `clear_reconciliation_dirty` lost nothing.

That check is textual and shallow; it compares assigned columns, not
semantics, and its guard-clause counter cannot see multi-line `if` conditions.
**Please redo it properly rather than trusting it** — reading is exactly what
failed for `claim_reconciliation_lease`.

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **578/578**, 25 files |
| `scripts/verify-local-database.mjs` | **41 checks**, real PostgreSQL 17, all **44 migrations**, incl. the migration-17 upgrade path |
| Isolated Playwright suite | **190/190**, zero failed, **zero skipped** |
| Stripe **test-mode lifecycle** | **16/16 phases**, real test clock, real invoices |
| `npm run typecheck` / `lint` / `build` | clean |
| Mutation tests | **8/8 caught** |

Each of the eight defects was re-introduced into the migration that fixes it
and the harness re-run; every one fails, naming its specific check. Two harness
checks and one browser test had to be **inverted** — they had encoded round-9
defects. (The browser one had already been inverted once, in round 9.)

Also found while running that suite: `SUPABASE_DB_URL` was never propagated
into the test process, so **45 tests — including the entire 32-case RPC
privilege matrix — had been silently skipping.** Earlier "zero skipped" claims
depended on that variable happening to be exported in a shell.

---

## Where to be most critical

### 1. Activation is now atomic, and the lease was removed entirely

This is the largest structural change in the diff and the one I am least sure
of. `write_activation` is **dropped**. `request_billing_activation` now takes
the verified evidence and, in a single `UPDATE`, sets `activated_at`, stores
the evidence, and advances both activation counters. It claims no
reconciliation lease at all.

My argument: the lease exists to serialize Stripe *reads* for subscription
refresh; activation performs no Stripe call and depends on no other row state,
and `activated_at = coalesce(activated_at, paid_at)` is idempotent and
order-independent — so there was nothing for the lease to protect.

**Questions.** Is that argument actually sound, or have I removed mutual
exclusion that something else quietly depended on? Specifically: can a
concurrent `write_reconciliation_result` — which reads the row `FOR UPDATE`,
then holds it across its own decisions — interleave with this write in a way
that loses the activation, or that computes its dirty flag from a row state
that no longer exists by the time it writes? Is advancing
`activation_requested` and `activation_completed` in the same statement (using
old-value semantics in the `SET` list) actually correct under concurrent
activations for the same organization?

And: with activation no longer able to leave an obligation outstanding, the
activation counters are arguably now dead weight that still appears in a dirty
predicate. Is keeping them a safety net, or a trap for the next reader?

### 2. Is "the subscription it created is terminal" the right test for R10-02?

For a `complete` Session whose `payment_status` is unresolved, the attempt is
released only if the subscription is `canceled` or `incomplete_expired`.
Everything else — including an unreadable subscription, and a completed
Session carrying **no** subscription reference — fails closed and keeps the
obligation pending.

**Questions.** Is that status set right and complete? Can a `canceled` or
`incomplete_expired` subscription still produce a charge (a trailing invoice,
a retry, a reactivation)? And is failing closed on "no subscription reference"
correct, or does it permanently trap an organization that can then never start
a checkout again — the reviewer of round 10 warned specifically against
presenting a permanent repair requirement as an endless "try again". I record
an anomaly and route to `OPERATOR_RECOVERY.md`; is that sufficient?

### 3. Is the three-state creation-key machine complete?

`unused` → nothing was ever sent, so create directly with no recovery.
`sent` → replay inside retention, enumerate outside it.
`unverified_legacy` → always enumerate.

**Questions.** Is the `unused` shortcut sound? It asserts that a creation
identity this app minted and never marked `sent` cannot correspond to any
Stripe Customer *for that organization* — is there a path where an
organization has a prior Customer but a freshly-minted `unused` identity?
(Rotation sets `unused` on the successor; is that safe given rotation only
happens after an enumeration proved absence?) Are there transitions the state
machine cannot represent, or states reachable that none of the three describe?

The fence before the external call (`mark_stripe_customer_key_sent`) requires
enough lease to remain to cover the call. I state plainly that this **narrows
but does not close** R10-05's stale-worker window, and that the residual case
is detected as an `orphaned_customer` anomaly. **Is that honest, or is it still
a guarantee dressed as a mitigation?**

### 4. The new explicit locks, and deadlock

`submit_feedback_atomic`, `claim_negative_alert_send` and
`reserve_notification_email_change` now take explicit row locks on
`public.organizations` before reading the clock — `FOR KEY SHARE` in the first
two (matching the foreign-key check they were implicitly waiting on) and
`FOR NO KEY UPDATE` in the third (matching its own later `UPDATE`).

I asserted a lock order — `nfc_cards → locations → organizations` — and argued
it is deadlock-free. **I did not prove it.** Please check independently: is
that order actually respected by every function that takes more than one of
these locks, including via triggers and foreign keys I may not have
enumerated? Is `FOR KEY SHARE` the correct mode, and does taking it explicitly
change behaviour anywhere beyond moving the wait earlier?

This is the **sixth** round in which an instance of the clock-before-lock class
has been found, and every prior class-wide search missed the next one. Please
search independently rather than trusting the claim that it is closed.

### 5. What else agrees with a bug?

Round 9 surfaced a browser test that had encoded the defect. Round 10 surfaced
two harness checks that had. This round I inverted them — but a test written
from the implementation is invisible to a green run, and I wrote a lot of new
tests this round.

**Question:** which of the new assertions restate what the code does rather
than what the product requires? `BILLING_INVARIANTS.md` is my attempt to make
that checkable; treat it as a claim to audit, not as authority.

### 6. Documentation that outruns the code

Round 10 found `DECISIONS.md` claiming reconciliation renewed its lease when
the service never called `renew_reconciliation_lease` at all. I have corrected
that and several others. **Please check the reverse direction too:** anything
in `BILLING_INVARIANTS.md`, `OPERATOR_RECOVERY.md`, `STATUS.md` or the new
migration headers that the code does not actually support.

---

## Known-unverified, deliberately

- **R10-02's own scenario has never been produced against real Stripe.** A
  `complete` Checkout Session with an unresolved payment needs an asynchronous
  payment method; with cards in test mode a Session completes already paid. It
  is covered by unit tests against the actual coordinator — the same level of
  evidence round 10's own reproduction used, and no more.
- **The app sends no `payment_method_types`**, which is how Stripe enables
  Dashboard-managed dynamic payment methods. Which methods customers actually
  see is an account *setting* this repository cannot establish. The "card only"
  claim was correctly rejected in round 10 and is now an owner action.
- **No live-mode Stripe transaction has ever been made.**
- **Production email configuration was changed today** — custom SMTP (Resend),
  both templates switched to the `token_hash` shape, hourly cap 2 → 100. The
  configuration is confirmed by an independent read, and the deployed
  production build genuinely has the `/auth/confirm` route those links target
  (verified: `master` contains it, it reads `token_hash` + `type`, and a live
  probe with a bogus token correctly redirects to `/auth/auth-code-error`).
  **But no real emailed link has been clicked against production yet.** An
  email that arrives proves only that the SMTP fault is fixed; only the click
  proves the template fault is. Treat production email as *applied, not
  proven*.
- **The five new migrations are applied only to the isolated project.**
- **Invoicing compliance remains an open question, not a settled fact** — see
  `BUSINESS_DECISIONS.md` § 2. Please do not resolve it by assumption.
- Standing ledger point: this repository can verify its own source, SQL and
  local migrations. Any claim about a **Stripe, Supabase or Vercel setting** is
  reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the six sections above — **including rejections**, and
   including "this fix is wrong" if that is what you conclude. Two of round 9's
   fixes were wrong and shipped green; that is the failure mode this round is
   most exposed to.
3. Anything asserted in the docs, migration headers or code comments that the
   code does not support.
4. Any test whose assertions were written from the implementation rather than
   from the requirement.
5. The riskiest remaining thing before this takes real money.

You will not have credentials for the isolated Supabase project, Stripe test
mode, or a mailbox. You can review the code, the SQL, the migrations and the
reasoning; any confirmation of the real-Stripe, browser-suite or email evidence
is a read of my logs, not independent verification. Please say so where it
matters rather than inheriting my numbers.
