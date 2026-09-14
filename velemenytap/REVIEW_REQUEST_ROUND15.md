# Review Request — Round 15 (independent review wanted)

**You are being asked for a written report**, not a patch.

Round 14 was the most useful review this project has had, because it read the
source and found that **the P1 fix I had shipped the day before was itself the
P1**. Please assume the same is true of this round's work.

**Branch:** `feature/billing-subscriptions` — open PR #4, **not merged.**
**Base:** `master` at `443ea98`. Production runs **migration 17**, with no
Stripe environment variables and none of the billing code.
**Review at:** the head of the branch (this file's own commit or later).
**New since round 14:** the five R14 fixes, then an audit pass that closed
three things this document originally listed as unaudited. Three forward
migrations (49–51). Total migrations **51**; `DEPLOYMENT.md` § 7 splits 18→51 into
**31 expand + 3 enforce**.

Read alongside `SECURITY.md`, `BILLING_INVARIANTS.md`, `OPERATOR_RECOVERY.md`,
`DATABASE_SCHEMA.md`, `DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`,
`LAUNCH_CHECKLIST.md`, `STATUS.md`'s round-14 entry and `BUSINESS_DECISIONS.md`.
`REVIEW_REQUEST_ROUND14.md` is the previous handoff and the round-14 report is
the input to this one.

## The trend

| Round | Findings | Notes |
|---|---|---|
| 9 | 7 (2 P1) | |
| 10 | 8 (2 P1) | two of round 9's *fixes* were wrong |
| 11 | 4 (1 P1) | round 10's redesigns accepted; the P1 was pre-existing |
| 12 | 4 (2 P1) | one P1 was introduced by round 11's fix |
| 13 | 1 | source unreachable; its one finding was disputed and later withdrawn by round 14 |
| 14 | 5 (1 P1) | **the P1 was in the fix shipped the day before**; two more were in that same day's work |
| 15 | ? | five fixes to five findings, plus an audit pass on two classes and one behaviour change round 14 declined to escalate |

Six rounds, and every round that could read the source found a defect in the
previous round's work. The base rate for "this round's fixes are correct" is
poor, and the fixes below are not exempt.

---

## What round 14 found, and what was done

| Finding | Fix |
|---|---|
| **R14-01 (P1)** — the password-change guard checked only that a cookie EXISTED; `HttpOnly` governs script reads, not the authenticity of an inbound `Cookie` header, so the attacker it named could simply send one | Migration 49. The cookie is a random 32-byte token used only as a lookup key; the authority is a row storing its SHA-256, bound to a user id, expiring on the database clock, consumed by an atomic conditional UPDATE behind a row lock. The routing-based PKCE grant is removed |
| **R14-02 (P2)** — the documented expand/enforce order ended with an OLDER definition of `confirm_notification_email_change` than a sorted replay, reinstating a fixed bug at finalize | Migration 51, appended **last** in `--enforce`. `20260906090000` left untouched |
| **R14-03 (P2)** — `mark_checkout_request_sent` evaluated `clock_timestamp()` before waiting for a row lock; a plain `SELECT … FOR UPDATE` holder suppresses the post-wait recheck | Migration 50: lock, then clock, mirroring `mark_stripe_customer_key_sent`, with a `p_required_seconds` margin |
| **R14-04 (P2)** — `getCurrentOrganization` read the earliest membership row it could SEE, returning the owner's role to a staff member | Filtered to the verified caller; asserted end to end through the real checkout form |
| **R14-05 (P2)** — warning/badge used raw truthiness while the CTA used `safeGoogleReviewUrl`, so a stored-but-invalid URL looked configured and produced no button | One predicate across badge, banner and CTA; "never set" told apart from "wrong kind" |

Also done, from the report's non-finding asks: the `"costs one retry"` comment
was corrected (it is a support state, not a retry, when the enumeration cap is
hit), `OPERATOR_RECOVERY.md` § 8 is the procedure that did not exist for it, and
the webhook handler's comment now states plainly that it is **not**
exactly-once and that two concurrent deliveries can both apply.

---

## Verification

| Check | Result |
|---|---|
| `npm run test` | **615/615**, 27 files |
| Isolated Playwright suite | **220/220**, zero failed, **zero skipped** — production build, CI's exact `workers: 1, retries: 1` |
| `npm run typecheck` / `lint` / `build` | clean |
| Mutation tests (this round) | **6/6 caught**, each by exactly the right test |

Five things to know before trusting any of it:

- **The first full run of this round failed 2/217**, both in the RPC privilege
  matrix, which noticed three new functions and a changed signature I had not
  registered. Third round running that this completeness check has caught
  something every other check missed.
- **Two more of my own tests were vacuous, making it three rounds running.**
  The replay regression initially passed because the cookie gets *cleared*
  after use, not because the server refuses a replay — it now captures the
  cookie before it is spent and re-presents it. Then the foreign-Session test
  passed by throwing on a missing mock before ever reaching the code under
  test. The shapes so far, all greppable: a case-insensitive substring match
  standing in for an exact one; a catch-all swallowing a rate limiter; an
  exception arriving before the assertion does; and an assertion on
  housekeeping rather than on the guarantee. **Assume there are more.**
- **A predicate I wrote was inert, and only a non-vacuity case caught it.** The
  second clock-before-lock shape's regex had its backslashes eaten by shell
  escaping, so it matched nothing and the audit would have reported a clean
  result for a check that could not fail. The synthetic fixture caught it
  immediately. Every audit result in § 2 and § 3 rests on its non-vacuity case
  being real — please check those first, and disbelieve the negatives if they
  are not.
- **Two `TEST_PLAN.md` lines described the PKCE grant this round removed**, and
  were corrected. Docs drifting behind a security change is this project's
  signature failure.
- **A gate written and never run.** `scripts/verify-local-database.mjs` gained a
  staged-order check — replay `--expand` then `--enforce` from `DEPLOYMENT.md`'s
  own manifest and assert the FINAL function definition. That is the check that
  would have caught R14-02 by itself. There is no longer a local PostgreSQL in
  this environment, so **it has never executed.** The R14-02 evidence I do have
  is a direct before/after against the isolated project, which is real but
  narrower than a clean staged replay from empty.

---

## Where to be most critical

### 1. The recovery grant, second attempt

The first version of this boundary was wrong in a way that read as correct.
Please treat the replacement with the same suspicion.

`features/auth/recovery-grant.ts` + migration `20260914100000`. The cookie is a
random token; the row holds its SHA-256, a `user_id`, `expires_at`, `consumed_at`.
`consume_password_recovery_grant` locks the row, reads the clock, checks user
match / unconsumed / unexpired, then updates.

**Questions.** Can the row be created without a real recovery email — is there
any path to `issue_password_recovery_grant` other than a verified `type=recovery`
OTP? Is binding to `user_id` sufficient, or should it also bind to the session
that will spend it (consider: recovery link opened, then a different account
signs in on that browser inside the 15 minutes)? Is the token's entropy and
storage right, and does comparing by SHA-256 lookup rather than a constant-time
compare matter here? Does `issue` expiring all of a user's prior unconsumed
grants create a denial-of-service against a legitimate recovery in progress?
Is `path=/auth` + `sameSite: lax` correct for the form that spends it?

And the design question I most want argued: I deliberately did **not** use the
session's own `amr`/`aal` claims, or Supabase's `secure_password_change`
reauthentication, because their shape is not a contract this project controls.
**Was that the right call, or have I rebuilt, worse, something the platform
already offers?**

### 2. R14-02's fix, and whether it generalises — AUDITED SINCE; check my audit

This section originally said "I did not audit for other pairs". That was not a
reasonable thing to outsource, so it is done.

**Audited:** every function, view, trigger and policy across all 51 migrations,
for objects defined by migrations landing in different rollout phases.
**Exactly one** — `confirm_notification_email_change`, which is R14-02 itself,
now resolved by the restore migration running last.

**Guarded:** `scripts/rollout-manifest.test.ts`, which needs **no database** and
therefore actually runs, unlike the harness gate. It asserts the invariant
rather than the symptom: *whichever migration defines an object LAST in the
staged order must be the one that defines it last in a sorted replay*, plus a
non-vacuity case that removes the restore migration and requires the divergence
to be detected.

**What that audit does NOT cover, stated plainly.** It extracts `create [or
replace] function/view/trigger` and `create policy`. It does **not** model
`grant`/`revoke`, `alter table`, indexes, constraints, column changes, or
`enable row level security` — and a permission revoked in one phase and
re-granted in another has exactly the same order-dependence. R14-02's own
sibling migration (`20260906090000`) is in `--enforce` *precisely because it
revokes a grant*, which is the category I have not modelled.

**Questions.** Is "last definer must match" the right invariant, or too weak?
Is the grant/revoke blind spot a real exposure in the current manifest — I have
not checked, and I am telling you rather than implying coverage I do not have.
And does "append a restore migration last" accumulate, with a third migration
touching that function needing a fourth?

### 3. Lock-before-clock — AUDITED SINCE; is there a third shape?

Also originally "please check for an eighth". Also done.

**Audited and guarded** by `scripts/lock-before-clock.test.ts`, over the current
definition of all 40 live functions, in the two shapes this class has taken:

1. the clock inside the `WHERE` of a statement that can wait (R14-03);
2. the clock read into a variable **before** a lock the function then waits on,
   so later comparisons use a moment that may be long past (R10-06/R10-07).

**No eighth instance in either shape.**

Both non-vacuity cases matter, and the second earned its keep immediately:
shape one is checked against migration 47's real pre-fix body; shape two has no
surviving real example, so its fixture is **synthetic and labelled as such** —
and it caught my predicate being inert the moment I wrote it, because a shell
escaping mistake had eaten the regex's backslashes.

**Questions.** Is there a third shape? The lint reads only the last definition
of each function, cannot tell whether a wait is reachable, and would miss a
clock read indirectly. Is `p_required_seconds` load-bearing anywhere, or a
comfort parameter defaulted to 0 at every call site? And does an advisory lock
(`pg_advisory_xact_lock`) count as "locked first", or does the class apply
there too?

### 4. The unrecorded-Checkout enumeration — CHANGED SINCE; was I right to?

Round 14 said the scanner "accepts the first open Session for the customer
without establishing that it belongs to this application's subscription
attempt", and that an operator-created Session for the same customer is a real
input it cannot distinguish — but did not turn that into a confirmed finding
because no ordinary app-created reproducer was established.

This document originally said "I have not changed that behaviour." I have now.

The enumeration took `batch.data.find(s => s.status === "open")` — any open
Session for that customer. A Stripe Customer is not this application's property:
an operator can create a Session against it from the Dashboard, and so can any
other integration on the account. Every Session this app creates already carried
`client_reference_id` **and** `metadata.organization_id`; the binding was
written and never read. It is now required, foreign open Sessions are counted
and logged, and "none of ours" is treated as the sound negative it is.

I also added `OPERATOR_RECOVERY.md` § 8 for the 20-page-cap state and corrected
the "costs one retry" comment, which was wrong in exactly the case that needs a
procedure.

**Questions.** Does requiring the binding create a NEW failure — a Session this
application genuinely created whose metadata is missing or stripped by some
Stripe path? Is accepting `client_reference_id` **or** `metadata` too
permissive; should it require both? And with foreign Sessions now ignored, a
stuck organization's outcome becomes "absent" rather than "found", which
releases the attempt and mints a new Session — **is that the right direction to
fail, given the attempt was `sent`?**

### 5. Everything in the customer-facing product still unreviewed by anyone

Signup and onboarding under adversarial input; the dashboard for anything a
lower-role member could reach; the public submission endpoint under sustained
abuse beyond the documented rate limit. Billing is not deployed; all of this is.

### 6. Tests that agree with the implementation

Seventh round asking, and this round produced another vacuous one. Which
assertions restate what the code does rather than what the product requires?
The two mechanisms found so far are greppable: a case-insensitive substring
match standing in for an exact one, and a `catch`-all around an operation that
can fail for reasons other than the one under test.

---

## Known-unverified, deliberately

- **The staged-order harness gate has never been run** (no local PostgreSQL).
- **R10-02's own scenario has never been produced against real Stripe** — a
  `complete` Session with an unresolved payment needs an asynchronous payment
  method, and cards in test mode complete already-paid.
- **No live-mode Stripe transaction has ever been made**, and the Stripe
  test-mode lifecycle has not been re-run since round 12; no billing *behaviour*
  changed this round, but `mark_checkout_request_sent`'s signature did.
- **Migration replay from a genuinely clean database has never been performed**
  here — left open rather than approximated.
- **The three new migrations are applied only to the isolated project.**
- **Invoicing compliance** remains an open business question
  (`BUSINESS_DECISIONS.md` § 2). Please do not resolve it by assumption.
- Standing ledger point: this repository can verify its own source, SQL and
  local migrations. Any claim about a **Stripe, Supabase or Vercel setting** is
  reported evidence unless someone re-read it that day.

---

## What a useful report looks like

1. Findings with severity, a concrete failure scenario, and how you reached it.
2. Explicit verdicts on the sections above — **including rejections**. § 1 and
   § 2 are the two I most want argued with.
3. Anything asserted in the docs, migration headers or code comments that the
   code does not support.
4. **Any test that would pass against the defect it names.** One did this round
   and one did last round.
5. The riskiest remaining thing before this takes real money.

If the honest answer to a section is "no finding", say so plainly. Round 14's
withdrawal of round 13's P1 classification was as useful as any of its five
findings, and round 11's judgement that round 10's redesigns should be retained
was as useful as any of its four.

You will not have credentials for the isolated Supabase project, Stripe test
mode, or a mailbox. Any confirmation of the real-Stripe, browser-suite or email
evidence is a read of my logs, not independent verification — please say so
where it matters rather than inheriting my numbers.
