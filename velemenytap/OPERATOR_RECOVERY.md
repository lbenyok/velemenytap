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
   Confirm `customer_creation_lease_expires_at` is in the past, then wait
   another few minutes. **Lease expiry does not prove an earlier request cannot
   still reach Stripe** — a paused process can resume at any time — so the
   final write in step 4 is conditional, and you re-check before committing.

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

5. **If no Customer exists**, the key may still be retired and creation
   retried. Verify step 2's quiesce again, then let the application do it:
   clear the stale lease and let the next checkout run its normal recovery.
   Only if that still cannot finish, rotate manually:

   ```sql
   select public.rotate_stripe_customer_creation($1, $2, $3);
   ```

6. **Orphaned Customers** (from an `orphaned_customer` anomaly or step 3):
   leave them in place unless finance asks otherwise. They carry no
   subscription and cost nothing. Do not delete a Stripe Customer that has any
   payment history.

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

## What none of this covers

An event Stripe never delivered *and* never retried, for an organization that
has since changed state, may need a historical authoritative source (the
Stripe Dashboard's event log, or an invoice export). The repository can
reconcile against Stripe's *current* state; it cannot reconstruct a past one it
never saw. Where that matters — an activation whose invoice is genuinely gone
— the evidence in `activation_evidence` is the audit record of what was
actually verified, and its absence means no payment was ever confirmed.
