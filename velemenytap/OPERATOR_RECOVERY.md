# Operator recovery

Three billing states can stop making progress on their own. Each fails closed
on purpose — refusing to guess is the correct behaviour, because the wrong
guess charges a customer twice or takes away access they paid for — but
"refuses to guess" is only safe if a person eventually looks. Repeating the
same failing query is not a recovery procedure.

This file is that procedure. Round 9 asked for it and round 10 recorded it as
still missing.

**Before anything else, in every procedure below:** confirm which Stripe
account and mode (test or live) you are in, and which Supabase project. Every
identifier here exists separately in test and live mode, and a repair applied
in the wrong one is itself an incident. `/api/health` reports the deployed
commit and latest migration.

---

## 1. Uncertain customer creation

**How it surfaces.** A checkout fails for one organization while others work.
The owner sees the generic `checkout_failed`; the server log carries the real
reason, one of:

- `Cannot establish whether organization N already has a Stripe customer …` —
  the canonical enumeration could not finish (an API error, or more than 2,000
  Customers in the window). The attempt is deliberately left pending.
- `A Stripe customer is already being created for organization N` — a live
  creation lease. Not a fault; it clears within 150 seconds. Only investigate
  if it persists.
- `The Stripe customer creation lease … is no longer held` — the worker was
  fenced before calling Stripe. Nothing was created. Safe to retry.

A `billing_anomalies` row of kind `orphaned_customer` means the opposite
problem: a Customer **was** created and nothing points at it.

**Why it cannot self-heal.** An absent Customer's search window only grows, so
once it contains more than 2,000 Customers the bounded enumeration can never
complete. Retrying reproduces the same incomplete answer forever.

**Procedure.**

1. **Gather the state.** For the organization:

   ```sql
   select organization_id, stripe_customer_id, customer_creation_id,
          customer_creation_key_state, customer_creation_started_at,
          customer_creation_lease_owner, customer_creation_lease_expires_at,
          billing_sync_last_error
   from public.organization_billing where organization_id = $1;
   ```

   `customer_creation_key_state` is the important one. `unused` means nothing
   was ever sent and there is nothing to find. `sent` means a request may have
   landed under `customer-create:<customer_creation_id>`. `unverified_legacy`
   means an older billing version may have created one under a key nobody
   recorded — that is the case that needs a real search.

2. **Quiesce first.** Do not repair while a worker may still be running.
   Confirm `customer_creation_lease_expires_at` is in the past.

   **Waiting is not proof.** An earlier draft of this step said to wait "another
   few minutes", which reads as though elapsed time establishes quiescence. It
   does not, and the round-11 review was right to reject it: lease expiry proves
   only that the database will refuse that worker's *writes*. It says nothing
   about a request already in flight at Stripe, and a suspended process can
   resume at any time. Expected-state database writes do not cancel external
   requests.

   What actually establishes quiescence is looking at the workers: confirm no
   deployment instance is still running that request (check the deployment's
   own logs or metrics for that organization), or that every instance which
   could have been has since restarted. Where you cannot establish it, say so
   and prefer the non-destructive branch — adopting an existing Customer
   (step 4) is safe under uncertainty; retiring a key and creating a new one
   (step 5) is not.

   Every write below is conditional and re-checks the row, so a repair racing a
   worker fails closed rather than overwriting it.

3. **Enumerate to completion**, past the application's 20-page cap, using the
   canonical list endpoint rather than Search (Search lags with no documented
   bound and can only produce false negatives):

   ```bash
   stripe customers list --created.gte <unix seconds> --limit 100
   ```

   starting from the organization's `created_at` (or
   `customer_creation_started_at`, whichever is earlier), paging with
   `--starting-after` until exhausted. Keep only Customers whose
   `metadata.organization_id` equals this organization.

   - **Exactly one match** → go to step 4.
   - **No match** → nothing was ever created. Go to step 5.
   - **More than one match** → do **not** pick one and do **not** delete any.
     Inspect each one's subscriptions, invoices and charges. If only one has
     financial history, that is the canonical Customer and the others are
     orphans; record which is which and why before proceeding. If more than one
     has financial history, stop and resolve it as a billing incident — that is
     a customer-money question, not a data-cleanup question.

4. **Persist the correct Customer** through the RPC, which refuses if the row
   has moved on underneath you rather than overwriting a newer answer:

   ```sql
   select public.record_stripe_customer($1, $2, $3);  -- org, creation_id, cus_…
   ```

   A `false` result means someone else resolved it first — re-read the row and
   stop; do not force it. Then run one reconciliation (the sweep endpoint, or
   the billing page) and confirm `status` and dashboard access match Stripe.

5. **If no Customer exists**, the key may be retired and creation retried.
   Verify step 2's quiesce again, then prefer letting the application do it:
   clear the stale lease and let the next checkout run its normal recovery.

   If it still cannot finish, rotate manually — **and note that rotation needs
   a live claim, which the previous version of this step did not obtain.**
   `rotate_stripe_customer_creation` requires the caller to hold the creation
   lease, by design (R9-03): a key may only be declared dead by whoever
   currently owns the right to declare it. Calling it with an expired lease
   returns `null`, and so does calling it after merely clearing the lease. Both
   were verified against the real RPC during the round-11 review; the step as
   written could not execute.

   Take a fresh claim and use **its** token:

   ```sql
   -- Returns customer_id, creation_id, started_at, retry_safe,
   -- needs_recovery, owner_token. Use the owner_token it hands back.
   select * from public.claim_stripe_customer_creation($1, 600);
   ```

   ```sql
   -- creation_id and owner_token BOTH from the claim above.
   select public.rotate_stripe_customer_creation($1, $2, $3);
   ```

   **Check every result.** A `null` from rotate means it was refused, not that
   it worked — the usual causes are a token from a different claim, a
   `creation_id` that has since changed, or a key still inside its retry-safe
   window (which is a protection, not a fault: a key Stripe would still
   deduplicate must not be retired). Re-read the row and re-establish the
   preconditions rather than retrying blindly.

   The claim's lease is what keeps your repair valid while you work. Take it
   with a duration that covers the whole repair, and if the work outlives it,
   take a fresh claim and re-verify the row before writing — an expired lease
   means someone else may have acted.

6. **Orphaned Customers** (from an `orphaned_customer` anomaly, an
   `unresolved_customer_creation` anomaly, or step 3): leave them in place
   unless finance asks otherwise. They carry no subscription and cost nothing.
   Do not delete a Stripe Customer that has any payment history.

   `unresolved_customer_creation` is the weaker of the two records and means
   what it says: this process created a Customer and could not establish which
   Customer the organization ended up on. It is **not** a confirmed orphan.
   Resolve it by reading the organization's current `stripe_customer_id` — if
   it differs from `createdCustomerId`, the created one is an orphan and the
   accompanying `orphaned_customer` row will usually say so; if the row is
   still unresolved, finish § 1 from step 3 first.

7. **Record what you did** — the evidence you gathered, the Customer you chose
   and why — on the anomaly row or your incident log.

---

## 2. A capped subscription history

**How it surfaces.** Reconciliation errors for one organization with
`more than 2000 subscriptions for customer cus_… -- refusing to decide
entitlement from a partial history`, and the sweep returns HTTP 500.

**Why it cannot self-heal.** Refusing to decide entitlement from a prefix is
correct — an older but still-active subscription can sit behind newer
terminal ones, and deciding from the first pages would revoke a paying
customer's access. But the history only grows, so the cap is never met again.

**Procedure.**

1. List the customer's subscriptions to completion:
   `stripe subscriptions list --customer cus_… --status all --limit 100`,
   paging with `--starting-after` until exhausted.
2. Apply the same selection rules the application uses
   (`pickCurrentSubscription`): consider only subscriptions whose primary
   price is an approved VéleményTap Price; an `active`/`trialing` one always
   beats a newer `past_due`/`incomplete`/`unpaid`/`paused` one; ties break by
   most recently created.
3. Investigate *why* there are so many. Over 2,000 subscriptions on one
   Customer is not normal usage and usually means a retry loop created them.
   Fix that cause before repairing the symptom.
4. Apply the chosen subscription with a normal reconciliation once the history
   is back under the cap, or raise `SUBSCRIPTION_PAGE_CAP` **together with**
   the lease budget. Raising the cap alone makes R10-08 worse: a longer scan
   with the same 45-second lease loses ownership before it can write. The
   pagination loop renews between pages, so the real limit is per-page latency,
   not total pages.

---

## 3. A persistent reconciliation backlog

**How it surfaces.** The scheduled sweep returns HTTP 500 with a `backlog`
array, and logs:

```
Reconciliation sweep: N organization(s) have been awaiting reconciliation for
over 3600s and are not converging on their own …
```

This is deliberately separate from per-run errors. An organization reaching it
has failed to converge across at least four consecutive sweeps, so it is not
ordinary lease contention.

**Procedure.**

1. Read the backlog directly for the full picture:

   ```sql
   select * from public.get_billing_reconciliation_backlog(3600, 50);
   ```

   `last_error` usually names the cause outright.

2. Match it to a shape:

   - **`billing_sync_requested > billing_sync_completed`, no error** — writes
     are being rejected for lost ownership. Check per-page Stripe latency: a
     scan slower than the lease is the R10-08 case. The loop renews between
     pages, so this now means individual calls are extremely slow, or the lease
     is being taken by a competing writer in a loop.
   - **A Stripe error in `last_error`** — an account, key or permission
     problem. Fix the cause; the dirty flag means nothing was lost.
   - **The capped-history error** — go to § 2.
   - **`activation_requested > activation_completed`** — should now be
     impossible; activation is written in one statement. If you see it, treat
     it as a genuine defect and capture the row before touching it.

3. After fixing the cause, trigger a sweep and confirm the backlog query
   returns empty. Do **not** clear `needs_reconciliation` by hand to silence
   the alarm — that discards the only durable record that work is outstanding,
   which is the guarantee the whole design rests on.

---

## 4. A checkout stuck on a Session with no subscription

**How it surfaces.** One organization cannot start checkout. The owner sees the
generic `checkout_failed`; the server log says the previous Session "may still
take payment … it completed with an unresolved payment and no subscription this
app can inspect", and a `completed_session_without_subscription` anomaly is
written.

**Why it cannot self-heal.** A completed subscription-mode Session normally
carries the subscription it created. Without one there is nothing to inspect,
so the code cannot establish that the payment is dead and fails closed (§ I3).
Retrying reproduces the same answer forever — for that organization this is a
permanent block, not an "try again in a moment", and it needs a person.

**Procedure.**

1. Read the Session directly and establish what it actually is:

   ```bash
   stripe checkout sessions retrieve cs_… --expand line_items
   ```

   Check `mode` (this app only creates `subscription`), `status`,
   `payment_status`, `subscription`, `payment_intent` and `invoice`.

2. **If a subscription does exist** and the app simply could not see it (an
   expansion or API-version difference), no repair is needed beyond confirming
   it: run a reconciliation and let the normal path take over.

3. **If there genuinely is no subscription**, determine the payment's
   disposition from the Session's `payment_intent` / `invoice`: succeeded,
   failed, or still processing. Still processing is not terminal — wait.

4. **Only once the payment is confirmed dead or refunded**, retire that exact
   attempt, checking the result.

   **This needs the CHECKOUT lease, not the customer-creation one.** An earlier
   version of this step said "a fresh claim, as in § 1 step 5" -- but § 1 step 5
   claims `claim_stripe_customer_creation`, and its token is meaningless to
   `release_checkout_attempt`. Called with it the release matches no row and the
   attempt survives. Found by the round-12 review actually executing it.

   Take a checkout claim. It validates the request against the row, so read the
   real values first:

   ```sql
   select stripe_customer_id, checkout_attempt_price_id, checkout_attempt_interval
   from public.organization_billing where organization_id = $1;
   ```

   ```sql
   -- $2 interval ('monthly'|'yearly'), $3 price id, $4 the request jsonb.
   -- The request must satisfy claim_checkout_attempt's own validation:
   --   mode='subscription', customer=<the row's stripe_customer_id>,
   --   line_items[0].price=$3, client_reference_id=<organization id as text>.
   select * from public.claim_checkout_attempt($1, $2, $3, $4::jsonb, 600);
   ```

   Then release with **that claim's** `attempt_id` and `owner_token`:

   ```sql
   select public.release_checkout_attempt($1, $2, $3);
   ```

   `release_checkout_attempt` is the only function that destroys a checkout
   identity deliberately, and it refuses unless the attempt id and owner token
   both match. Called directly in SQL it returns **no row (NULL)** when it
   refuses -- not `false`; the `false` the application sees is its own
   normalisation. Either way: re-read the row and stop rather than retrying.

5. **If the payment succeeded but produced no subscription**, that is a real
   billing incident — the customer has been charged for nothing. Resolve it in
   Stripe (refund, or create the subscription deliberately) before touching the
   attempt, and record what was done.

## 5. Who looks at anomalies, and how

**`private.billing_anomalies` is a record, not a notification.** Nothing pushes
it anywhere. The reconciliation backlog query (§ 3) scans
`organization_billing` and **does not** scan this table, so an anomaly on its
own will not page anyone.

Until a real alerting path exists, this is the operational answer, and it is
deliberately explicit because "it is recorded" was previously offered as though
it meant "someone will know":

- **Owner (the person running the business) reviews it weekly**, and
  immediately whenever a customer reports that checkout or the dashboard is
  wrong for them. There is one operator; pretending otherwise would be fiction.

  ```sql
  select detected_at, organization_id, kind, detail
  from private.billing_anomalies
  order by detected_at desc
  limit 50;
  ```

  (The column is `detected_at`. An earlier version of this document said
  `created_at`, which does not exist -- the query failed immediately with
  "column created_at does not exist", blocking the only documented review of
  every anomaly kind below. Found by the round-12 review actually running it.)

- The kinds and where each is handled:

  | Kind | Section |
  |---|---|
  | `unresolved_customer_creation` | § 1 step 6 |
  | `orphaned_customer` | § 1 step 6 |
  | `completed_session_without_subscription` | § 4 |
  | `activation_request_without_evidence` | § 6 |
  | `customer_mismatch`, `unapproved_subscription`, `duplicate_active_subscriptions` | investigate in Stripe; these predate this document |

- **The owner-facing error is always generic `checkout_failed`.** A customer
  hitting a permanent block has no way to distinguish it from a transient one,
  so the support contact in `BUSINESS_DECISIONS.md` is the only route back —
  which is one more reason that decision is a launch blocker rather than
  cosmetic.

## 6. An activation closed without evidence

Migration `20260910100000` closed any activation left pending by the old
two-phase design, recording an `activation_request_without_evidence` anomaly
for each. That was the right call — such a request is unfalsifiable, and
leaving it pending is the R10-03 livelock — but **it is a closure, not a
recovery.**

The organization may genuinely have paid. Its access is currently decided as if
it had not.

**Verify in Stripe first**, because this call writes the irreversible ever-paid
latch (§ I1): the invoice must be `paid`, its Customer must be the one this
organization is persisted against, and its subscription must carry an approved
VéleményTap Price. Those are exactly the checks the webhook performs, and
nothing re-checks them here.

Then call it as `service_role` -- the RPC is service-role only, so this runs
from the Supabase SQL editor or a trusted server context, never an application
client:

```sql
select public.request_billing_activation(
  $1,
  jsonb_build_object(
    'invoice_id',      'in_...',
    'subscription_id', 'sub_...',
    'price_id',        'price_...',
    'paid_at',         '2026-09-01T12:00:00Z'
  )
);
```

It returns the resulting `activated_at`. Every field is required and
`paid_at` must parse and not be in the future, or it raises `VT303` and
writes nothing. Confirm afterwards:

```sql
select activated_at, activation_evidence, activation_requested, activation_completed
from public.organization_billing where organization_id = $1;
```

`activated_at` should equal the invoice's `paid_at`, the evidence should
name that invoice, and the two counters should be equal. The latch is
first-evidence-wins, so a second call cannot re-date it.

Related, and important when reading any pre-round-10 row: **a null
`activation_evidence` does not prove no payment happened.** Rows latched before
migration 40 — including ones latched by the round-9 `active`-means-paid bug —
carry no evidence at all. Null means "not recorded", not "not paid". Do not
clear a legitimate paid organization's latch on that basis; audit it against
Stripe's own history first. (Production is on migration 17 and has never run
any of this, so it has no such rows.)

---

## What none of this covers

An event Stripe never delivered *and* never retried, for an organization that
has since changed state, may need a historical authoritative source (the
Stripe Dashboard's event log, or an invoice export). The repository can
reconcile against Stripe's *current* state; it cannot reconstruct a past one it
never saw. Where that matters — an activation whose invoice is genuinely gone
— the evidence in `activation_evidence` is the audit record of what was
actually verified, subject to the null-evidence caveat in § 6.
