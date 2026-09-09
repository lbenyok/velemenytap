# Review Request — Round 9 (independent review wanted)

**You are being asked for a written report**, not a patch. Read the code, disagree
where you disagree, and say so plainly. Prior rounds of this project have been most
useful when the reviewer rejected a claim rather than confirming it — two of this
round's own three defects were found exactly that way, by checking a claim this
repository made about a vendor's behaviour against that vendor's documentation.

Read alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`,
`SECURITY.md`, `DECISIONS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, `STATUS.md`,
`LAUNCH_CHECKLIST.md` and `BUSINESS_DECISIONS.md`, all updated to the current state.

**Branch:** `feature/billing-subscriptions` — **open PR #4, not merged, nothing
deployed.** Production still runs migration 17 with no Stripe environment variables.
**Base:** `master` at `443ea98`.
**This round's range:** `08f765f..0799f8a` — 7 commits, 70 files, +5339/−535.
**Three new migrations**, applied only to the isolated Supabase test project:
`20260908100000`, `20260908110000`, `20260908120000`.

---

## What this round did

It began as an integration task: a second agent had independently built its own
product-fix pass against a copy of this repo. The instruction was to review that work,
then bring over what was genuinely better — **onto this repository's own design, via
new forward migrations**, never by reverting or wholesale replacement.

Two mechanisms were adopted because this implementation had real defects they closed:

1. **Checkout attempt identity was destroyed by lease expiry** (`20260908100000`). One
   column meant both "this request owns the slot" and "this attempt exists". A request
   that died after `sessions.create()` returned but before recording its Session lost
   the attempt id — the next request minted a fresh one, therefore a fresh idempotency
   key, and Stripe created a genuine **second** Checkout Session. Split into a durable
   attempt plus a short operation lease, with an immutable `checkout_request` snapshot
   replayed verbatim, and the Session recorded *before* it is validated.

2. **An event arriving during a reconciliation was silently lost**
   (`20260908110000`). The exclusive lease gave mutual exclusion, but a *completing*
   write cleared `needs_reconciliation` unconditionally — including the flag a newer
   webhook had set moments earlier after failing to claim the lease. Fixed with a
   monotonic generation pair, plus staleness-based sweep candidates for the case where
   this app was never told anything at all.

One mechanism was **rejected on the merits and that rejection was wrong**, which
produced the third migration — see § "Where to be most critical" below.

---

## Verification performed

| Check | Result |
|---|---|
| `npm run test` | 557/557, 24 files |
| `npm run typecheck` / `lint` / `build` | clean |
| `scripts/verify-local-database.mjs` | 29 checks against real PostgreSQL 17 |
| Isolated Playwright suite | 186/186, zero failed, zero skipped |
| Migration drift | 36 local = 36 remote on the isolated project |

**Real Stripe test-mode, not mocks** (isolated Supabase project, test keys,
`stripe listen`): initial monthly purchase (14 signed webhooks, all HTTP 200); annual
checkout (`current_period_end` exactly 365 days out); and — via Stripe test clocks —
renewal, failed payment, recovery, cancellation and resubscription, each ending with
`billing_sync_requested == billing_sync_completed`, `needs_reconciliation = false`, and
`activated_at` set once and never rewritten.

**Claims about vendor behaviour were tested, not assumed:**

- Replaying an attempt's idempotency key with identical parameters returns the **same**
  Session; with **different** parameters it is **rejected** (`StripeIdempotencyError`).
  The second is why the request snapshot must be stored rather than rebuilt.
- A Stripe Customer created and then immediately searched for returned **zero**
  results, while `customers.list({created:{gte}})` found it on the first page.
- Supabase Auth emails were received in a real mailbox and the links **clicked**:
  signup → `/onboarding`, resend → `/onboarding`, password reset →
  `/auth/reset-password` with a real session cookie.

---

## Where to be most critical

### 1. The customer-recovery argument (highest value target)

This is the part most likely to still be wrong, because it has already been wrong twice.

`getOrCreateStripeCustomerId` must answer: *did an earlier, interrupted attempt already
create this organization's Stripe Customer?* Stripe documents that Customer Search is
**not** read-after-write consistent, and that idempotency keys are pruned after ~24
hours ("we generate a new request if a key is reused after the original is pruned").

- **First version:** used search as the recovery mechanism, and treated a *failed*
  search identically to an empty one. A create that succeeded but whose response was
  lost, retried a day later while search was failing, produced a duplicate Customer —
  and reconciliation only ever lists subscriptions for the customer persisted locally,
  so a customer paying on the other one is charged and locked out.
- **Second version:** restored a frozen creation identity, but still authorized
  creating when the search came back cleanly empty and the attempt was old, reasoning
  that an existing Customer "would have been indexed by now". That is an inference from
  a statement about *typical* behaviour ("up to an hour behind during outages"), with no
  stated upper bound, used to license an irreversible chargeable action.
- **Current version:** creation is authorized **only** by a completed enumeration of
  `customers.list` over the bounded window the attempt could have created in. Search is
  used only for *positive* identification, where its staleness cannot mislead. Anything
  that stops the enumeration finishing is `unknown`, and the attempt is left pending.

**Questions for you:** Is the claim that `customers.list` is strongly consistent
actually supported, or is it only *not documented as inconsistent*? Is the bounded
window (attempt time − 5 min, capped at 20 pages) sound, including for rows backfilled
by the migration whose recorded time is less precise? Is there a state where an
organization becomes permanently stuck pending, and is that acceptable?

### 2. The generation counters

Does the pair genuinely prevent loss, or does it move the race? Specifically: a request
is registered *before* the reconciler reads Stripe. Is there an interleaving where a
reconciler satisfies a generation whose triggering event described state it had not yet
observed? `scripts/verify-local-database.mjs` exercises this against real Postgres —
check whether the test proves what it claims.

### 3. Lock-then-check

Every lease-timed `UPDATE` now takes an explicit `select ... for update` first, because
Postgres evaluates the `expires_at > clock_timestamp()` qual during the scan — before
waiting behind another transaction's row lock — and re-checks it afterwards only if the
blocker modified the row. This was a real defect in already-applied `20260907210000`,
found by a harness that blocks a real second connection behind a real lock. **Has the
whole class been found?** This project has now hit `now()`/`clock_timestamp()`-after-lock
four times and each previous "we searched for the class" missed the next instance.

### 4. Things fixed that were previously asserted as done

Two claims in this repository turned out to be false, both written as completed facts:

- **The Vercel project rename never happened.** `.vercel/project.json` still reads
  `veleminytap`; `velemenytap.vercel.app` 404s. `scripts/rollout-environments.json` had
  `allowedOrigin` and `healthUrl` pointing at the dead host, so the production migration
  rollout would have health-gated against a URL that does not exist.
- **Auth email had two independent faults, not one.** No custom SMTP on either project
  (built-in mailer, 2/hour, team members only) *and* templates using
  `{{ .ConfirmationURL }}`, which redirects with the session in a URL fragment a server
  route can never read — so every link dead-ended on `/auth/auth-code-error` even though
  the token was consumed correctly. The app has always implemented the `token_hash`
  flow; the templates never matched it. Fixing only SMTP produces emails that arrive and
  links that still fail, which is exactly what the first verification run showed.

**Worth asking:** what else in this documentation set asserts a completed external
action that nobody verified? That failure mode has now occurred twice.

### 5. The product invariant

The Google Review CTA must be available for ratings 1–5, identically, and the paywall
must never gate the public feedback flow. Both are covered by tests, but this is the one
thing where a regression would be worst — please check it independently rather than
trusting the suite.

---

## Known-unverified, deliberately

- **No live-mode Stripe transaction has ever been made.** Test mode is proven; live mode
  shares none of that configuration.
- **Production email is unfixed.** Both faults above are fixed and verified on the
  isolated project only; production is untouched pending owner action.
- **Invoicing compliance is an open question, not a settled fact.** Stripe issues
  receipts; nothing here generates an invoice or reports to NAV. What Hungarian law
  requires of this business is explicitly *not* asserted anywhere — see
  `BUSINESS_DECISIONS.md` § 2. Please do not resolve it by assumption either.
- The physical NFC card price has no source in this repo and is deliberately
  unpublished; legal documents (impresszum, ÁSZF, privacy policy) and a support contact
  do not exist yet.

---

## What a useful report looks like

1. Findings, each with severity, the concrete failure scenario, and how you reproduced
   or reasoned to it — not a list of style preferences.
2. Explicit verdicts on the four claims in "Where to be most critical", including
   **rejections** where the reasoning does not hold.
3. Anything asserted in the docs that you could not verify from the code.
4. Whatever you think the riskiest remaining thing is before this takes real money.
