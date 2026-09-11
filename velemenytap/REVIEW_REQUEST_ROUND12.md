# Review Request — Round 12 (independent review wanted)

**You are being asked for a written report**, not a patch.

## Why this round is framed differently

Three rounds have now reviewed this same billing code, and the trend matters:

| Round | Findings | Were the *previous* round's fixes right? |
|---|---|---|
| 9 | 7 (2 P1) | — |
| 10 | 8 (2 P1) | **No** — two of round 9's fixes replaced one invariant with a false one |
| 11 | 4 (1 P1) | **Yes** — round 10's redesigns were accepted after independent reproduction |

Round 11's P1 was **not** something round 10 introduced. It was a pre-existing
write that round 10 preserved faithfully, and that my own post-round-10 audit
was structurally incapable of seeing: I compared every `UPDATE ... SET` column
of the re-created functions and reported "no unintended loss", which was true
and useless, because the defective cleanup was *unchanged*. A column-level diff
answers "did this write change". It cannot answer **"is this write entitled to
touch these rows at all?"**

That question is the most valuable thing to bring to this round, and I have
deliberately **not** tried to answer it exhaustively myself — my track record
on self-audits of exactly this kind is the reason it went unfound for three
rounds.

Read alongside `BILLING_INVARIANTS.md`, `OPERATOR_RECOVERY.md`, `STATUS.md`'s
round-11 entry, `DATABASE_SCHEMA.md`, `DECISIONS.md`, `TEST_PLAN.md`,
`DEPLOYMENT.md`, `LAUNCH_CHECKLIST.md` and `BUSINESS_DECISIONS.md`.
`REVIEW_REQUEST_ROUND11.md` is the previous handoff.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged.**
**Base:** `master` at `443ea98`. Production runs **migration 17** with no Stripe
environment variables.
**Round-11 response range:** `4d5a479..dd8d7cf` — 1 commit, 13 files,
+840/−34.
**Two new migrations** (45–46), applied only to the isolated test project:
`20260910150000`, `20260910160000`.

---

## What round 11 found, and what was done

| Finding | Fix |
|---|---|
| **R11-01 (P1)** — every successful subscription refresh cleared the checkout attempt, its stored request and `pending_checkout_session_id` unconditionally, so reconciling an *older canceled* subscription erased a live open Checkout and the next attempt created a second payable Session | retirement is now conditional: **no recorded Session pointer AND no live operation lease** |
| **R11-02 (P2)** — activation raised `needs_reconciliation` but never advanced `billing_sync_requested`, so a stale reconciler could clear the flag and leave a newly paid organization `past_due` | the generation is advanced in the same atomic statement as the payment |
| **R11-03 (P2)** — the orphan record R10-05 promised was written *after* a resolution step that legitimately throws, losing the created Customer's id | recorded as `unresolved_customer_creation` **before** anything fallible; classified as a confirmed orphan only once a different winner exists |
| **R11-04 (P2)** — the operator procedure told you to rotate a creation key without the live claim rotation requires; verified `null` with an expired lease and `null` after clearing it | fresh claim, its token, every result checked; plus new sections for the stuck-Session state, who reads anomalies, and evidence-less activations |

Also: a sixth instance of the clock-before-lock class
(`issue_notification_email_change_token`); the universal "deadlock-free" lock
order narrowed after an administrative cascade `DELETE` was demonstrated to
deadlock; and `§ I3` corrected to stop listing "none ever created" as a release
condition and to record that `canceled` is weaker than "no further money can
ever be collected".

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **579/579**, 25 files |
| `scripts/verify-local-database.mjs` | **45 checks**, real PostgreSQL 17, all **46 migrations**, incl. the migration-17 upgrade path |
| Isolated Playwright suite | **190/190**, zero failed, zero skipped |
| Stripe **test-mode lifecycle** | **16/16 phases**, re-run after these changes |
| `npm run typecheck` / `lint` / `build` | clean |
| Mutation tests | **5/5 caught** (four SQL, one TypeScript) |

One browser assertion was **deliberately loosened**: it pinned
`billing_sync_requested` to a literal `1`, which would have asserted the
*absence* of R11-02's fix. It now asserts `completed === 0` and
`requested > completed`. Please check that I narrowed its meaning correctly
rather than weakening it.

---

## Where to be most critical

### 1. Which component owns which column? (highest value)

R11-01 was one instance of a general failure: a writer touching state that
belongs to a different component's lifecycle. Reconciliation owns subscription
state; the checkout coordinator owns checkout state; only the coordinator ever
retrieves a Session from Stripe. Reconciliation was nonetheless destroying
checkout state, and had been for many rounds.

**Please audit that question across the whole schema, not just the fix.** For
each writer of `organization_billing` — the RPCs, and anything else — which
columns does it write, which component's lifecycle do those columns belong to,
and is it entitled to? I am specifically asking whether there are **more
instances**, not whether this one is fixed.

Candidates I would start from, without having concluded anything:
`release_reconciliation_lease`, `fail_billing_reconciliation`,
`clear_reconciliation_dirty`, `record_stripe_customer`,
`rotate_stripe_customer_creation`, and the checkout RPCs writing billing state.

### 2. Is R11-01's own predicate right?

Retirement now requires `pending_checkout_session_id is null` **and** no live
`checkout_attempt_expires_at`.

**Questions.** Is that predicate complete — is there a state where an attempt
still matters but satisfies both conditions? Conversely, have I created the
opposite failure: can an attempt now **leak permanently**, never retired,
blocking or misdirecting an organization's future checkouts? The abandoned-claim
path is covered by a regression, but I would rather you looked for the case I
did not think of. Round 10 fixed a livelock by creating a wrong write; the
symmetric risk here is fixing an over-broad write by creating a stuck one.

### 3. R11-02's cost

Every `invoice.paid` now advances `billing_sync_requested`, so every payment
forces a reconciliation that must be completed by someone.

**Questions.** Does that interact badly with the sweep's one-minute back-off or
its batch limit under a renewal burst — many organizations renewing in the same
window, each now demanding a refresh? Is there a path where the extra
generation makes convergence *slower* than the problem it fixes? The 16/16
lifecycle converges, but it exercises one organization.

### 4. Two anomaly kinds for one event

R11-03 writes `unresolved_customer_creation` first and `orphaned_customer`
after, when resolution succeeds and differs.

**Questions.** Is that pair coherent, or does it produce a misleading record —
e.g. an `unresolved_customer_creation` with no follow-up, for a request that
actually resolved fine? Is the distinction between "unresolved" and "confirmed
orphan" one an operator can act on, or noise dressed as precision?

### 5. Are the operator procedures executable?

Round 11 found a documented repair step that **could not run** — it called an
RPC without the ownership token that RPC requires. `OPERATOR_RECOVERY.md` has
since roughly doubled in size, and none of the new material has been executed
by anyone.

**Please try to execute the procedures against the schema**, as round 11 did,
rather than reading them. § 1 step 5 (rotation with a fresh claim), § 4 (a
stuck Session with no subscription) and § 6 (an activation closed without
evidence) are the untested ones. Do the SQL calls work, do the arguments exist,
do the results mean what the document says?

### 6. The rollout itself

This has not been reviewed in several rounds and is the actual next step toward
taking money. There are now **46** migrations; production is on **17**;
`DEPLOYMENT.md` § 7 splits 18→46 into `--expand` (25) and `--enforce` (2)
phases, run either side of the application deploy.

**Questions.** Is that split still correct after everything rounds 9–11 added?
Several of these migrations change function signatures, which is normally
exactly what needs an expand/enforce split — the argument that it is safe here
rests entirely on *none of them having ever been deployed*, so there is no old
caller to keep working. Is that argument still sound for all 27? Is there any
ordering in which an intermediate state breaks the currently-deployed code?

### 7. Tests, again

Round 9 surfaced one test that had encoded a defect; round 10 surfaced two;
round 11 found several new assertions "valid but narrower than their
descriptions". Which of the round-11 assertions restate the implementation
rather than the requirement?

---

## Known-unverified, deliberately

- **R10-02's own scenario has never been produced against real Stripe.** A
  `complete` Session with an unresolved payment needs an asynchronous payment
  method; with cards in test mode a Session completes already paid. Covered by
  unit tests against the actual coordinator, and no more.
- **The app sends no `payment_method_types`**, so which methods customers
  actually see is a Stripe account setting this repository cannot establish.
- **No live-mode Stripe transaction has ever been made.**
- **Production email is applied but not proven.** Custom SMTP and both
  `token_hash` templates were applied to production and confirmed by an
  independent read; the deployed build genuinely has the `/auth/confirm` route
  those links target. **No real emailed link has been clicked against
  production.** An email that arrives proves only the SMTP half.
- **The two new migrations are applied only to the isolated project.**
- **Invoicing compliance remains an open question, not a settled fact** — see
  `BUSINESS_DECISIONS.md` § 2. Please do not resolve it by assumption.
- Standing ledger point: this repository can verify its own source, SQL and
  local migrations. Any claim about a **Stripe, Supabase or Vercel setting** is
  reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the seven sections above — **including rejections**, and
   including "this fix is wrong" if that is what you conclude.
3. For § 1 especially: a table of writer → columns → owning component would be
   more useful than prose, and would outlive this round.
4. Anything asserted in the docs, migration headers or code comments that the
   code does not support.
5. The riskiest remaining thing before this takes real money.

If the honest answer to a section is "no finding", say so plainly — three
rounds of confirmed defects make it tempting to produce something, and a
manufactured finding costs more than a quiet section. Round 11's judgement that
round 10's redesigns should be **retained** was as useful as any of its four
findings.

You will not have credentials for the isolated Supabase project, Stripe test
mode, or a mailbox. You can review the code, SQL, migrations and reasoning; any
confirmation of the real-Stripe, browser-suite or email evidence is a read of
my logs, not independent verification. Please say so where it matters rather
than inheriting my numbers.
