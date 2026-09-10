-- Round 10 independent review, findings R10-01 (P1) and R10-03 (P2). A forward
-- migration on top of 20260909100000; nothing already applied is edited.
--
-- THE DEFECT (R10-01). Round 9 split the activation generation from the
-- subscription generation -- correct, and kept -- but paired it with an
-- anti-deadlock rule that was wrong: write_reconciliation_result set
-- activated_at whenever it wrote an `active` status, "from evidence it already
-- holds".
--
-- It does not hold that evidence. `active` is not a payment. Stripe documents
-- a `collection_method=send_invoice` subscription as starting active while its
-- first invoice is still unpaid, and a subscription can be created active
-- out-of-band from the Dashboard or API with no payment at all. The review
-- reproduced the consequence against this schema and the real access function:
-- a grandfathered organization given an approved-price invoiced subscription
-- that is never paid gets activated_at set permanently, and when that
-- subscription is later canceled it loses its promised prepayment grace
-- FOREVER. Access went true -> true -> false with no activation ever requested
-- and no invoice ever paid.
--
-- activated_at is a one-way latch that ends grandfathering (see
-- features/billing/status.ts), so a false positive is unrecoverable without
-- manual repair. It may only be written from evidence that a payment genuinely
-- settled.
--
-- THE DEFECT (R10-03). The reason round 9 reached for that wrong rule was
-- real: activation was a TWO-PHASE operation. request_billing_activation
-- registered an obligation, and a separate write_activation -- under the
-- reconciliation lease -- discharged it. A handler that verified a paid
-- invoice, requested activation, then died before writing it left an
-- obligation that only another invoice event could satisfy. If the invoice was
-- never redelivered and the subscription was since canceled, every sweep could
-- refresh the subscription and none could ever finish the activation: a
-- repeated-work livelock, with the organization keeping grandfathered access
-- it had actually paid its way out of.
--
-- THE FIX: make the two phases one.
--
-- The verified payment fact and the durable record of it are now written in a
-- SINGLE statement, together with the evidence itself. There is no window in
-- which an activation is requested but not performed, so:
--
--   * nothing can interrupt it (R10-03 cannot arise -- a pending activation
--     cannot exist, which is strictly stronger than "a pending activation can
--     be finished later"); and
--   * no writer ever has to reconstruct the payment fact from a current Stripe
--     status, which is what R10-01 was (R10-01 cannot arise either).
--
-- This is why write_activation is dropped rather than repaired: it WAS the
-- interruptible half. The reconciliation lease exists to serialize Stripe
-- READS for subscription refresh; activation performs no Stripe call and
-- depends on no other row state -- `activated_at = coalesce(activated_at,
-- paid_at)` is idempotent and order-independent -- so it never needed the
-- lease at all. Removing it removes the livelock by construction rather than
-- adding a recovery path that itself has to be kept working.
--
-- WHAT COUNTS AS EVIDENCE is deliberately unchanged from the original
-- invoice.paid path: a signed invoice.paid event, invoice status `paid`, the
-- invoice's Customer matching the organization's persisted Customer, and the
-- subscription carrying an approved VéleményTap Price (all verified in
-- app/api/webhooks/stripe/route.ts before this is ever called). In particular a
-- ZERO-TOTAL paid invoice still activates -- a 100%-off coupon settles the
-- invoice and Stripe reports it `paid` -- because the previous path already
-- accepted that and narrowing it here would silently revoke access from
-- organizations that legitimately have it. Fixing recovery must not quietly
-- redefine "ever paid". See BILLING_INVARIANTS.md § I1/I2.

alter table public.organization_billing
  add column activation_evidence jsonb;

comment on column public.organization_billing.activation_evidence is
  'The verified payment that set activated_at: the invoice.paid evidence '
  '(invoice_id, subscription_id, price_id, paid_at) recorded atomically with '
  'the latch. First evidence wins, matching the latch itself. Null means '
  'activated_at was never set. Audit trail for why an organization is '
  'considered to have ever paid -- R10-01 existed because that reason was not '
  'recorded anywhere and was therefore re-derived, wrongly, from live status.';

-- ---------------------------------------------------------------------------
-- Activation: one statement, evidence required.
-- ---------------------------------------------------------------------------

drop function if exists public.request_billing_activation(bigint);

create function public.request_billing_activation(
  p_organization_id bigint,
  p_evidence jsonb
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_paid_at timestamptz;
  v_activated_at timestamptz;
begin
  -- Evidence is not optional. The whole point of R10-01's fix is that there is
  -- no way to reach activated_at without producing the payment that justifies
  -- it, so a caller that has none must fail loudly rather than activate.
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'activation requires verified payment evidence' using errcode = 'VT303';
  end if;
  if coalesce(p_evidence->>'invoice_id', '') = ''
     or coalesce(p_evidence->>'subscription_id', '') = ''
     or coalesce(p_evidence->>'price_id', '') = ''
     or coalesce(p_evidence->>'paid_at', '') = ''
  then
    raise exception 'activation evidence must carry invoice_id, subscription_id, price_id and paid_at'
      using errcode = 'VT303';
  end if;

  begin
    v_paid_at := (p_evidence->>'paid_at')::timestamptz;
  exception when others then
    raise exception 'activation evidence paid_at is not a timestamp: %', p_evidence->>'paid_at'
      using errcode = 'VT303';
  end;

  v_now := clock_timestamp();

  -- A settlement instant in the future is not evidence of a settlement. The
  -- hour of slack absorbs ordinary clock skew between Stripe and this database
  -- without accepting a plainly wrong timestamp.
  if v_paid_at > v_now + interval '1 hour' then
    raise exception 'activation evidence paid_at % is in the future', v_paid_at using errcode = 'VT303';
  end if;

  -- One statement. activated_at, its evidence, and BOTH activation counters
  -- move together, so activation_requested > activation_completed -- the state
  -- R10-03's livelock lived in -- is never produced.
  --
  -- needs_reconciliation is still raised: a payment usually means the
  -- subscription's own status just changed too, and that refresh is a
  -- genuinely separate obligation with its own counter. It is now satisfiable,
  -- because the activation half is already done.
  update public.organization_billing
  set activated_at = coalesce(activated_at, v_paid_at),
      activation_evidence = coalesce(activation_evidence, p_evidence),
      activation_requested = activation_requested + 1,
      activation_completed = activation_requested + 1,
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
  where organization_id = p_organization_id
  returning activated_at into v_activated_at;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  return v_activated_at;
end;
$$;

revoke execute on function public.request_billing_activation(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.request_billing_activation(bigint, jsonb) to service_role;

-- The interruptible half. Nothing replaces it: activation is now atomic.
drop function if exists public.write_activation(bigint, text, bigint, bigint);

-- ---------------------------------------------------------------------------
-- Resolve obligations left pending by the two-phase design.
-- ---------------------------------------------------------------------------
--
-- Production is on migration 17 and has never run any of this, so in practice
-- this touches nothing there. It matters for the isolated test project and any
-- environment that ran 20260909100000: a row with activation_requested >
-- activation_completed and no evidence is UNFALSIFIABLE -- there is no record
-- of what payment it referred to, and nothing that could ever discharge it, so
-- leaving it is exactly R10-03's livelock. It is recorded as an anomaly (so it
-- is visible rather than silently dropped) and then closed.

insert into private.billing_anomalies (organization_id, kind, detail)
select b.organization_id,
       'activation_request_without_evidence',
       jsonb_build_object(
         'activation_requested', b.activation_requested,
         'activation_completed', b.activation_completed,
         'activated_at', b.activated_at,
         'note', 'closed by migration 20260910100000; the two-phase activation design recorded no evidence to recover from'
       )
from public.organization_billing b
where b.activated_at is null
  and b.activation_requested > b.activation_completed;

update public.organization_billing
set activation_completed = activation_requested
where activation_requested > activation_completed;

-- ---------------------------------------------------------------------------
-- Reconciliation writers: no longer carry an activation generation, and never
-- derive activated_at.
-- ---------------------------------------------------------------------------
--
-- The activation generation was threaded through the lease so that a
-- subscription refresh could not discharge a pending activation (R9-02). With
-- activation atomic there is no pending activation for it to discharge, so the
-- parameter is removed rather than left as an ignored argument -- an ignored
-- argument is exactly the kind of thing a later reader mistakes for an
-- enforced rule.
--
-- The activation clause in the dirty predicate is deliberately KEPT as a
-- safety net: nothing can now open a gap between the counters, and if
-- something ever did, the organization must stay dirty rather than be silently
-- marked clean.

drop function if exists public.claim_reconciliation_lease(bigint, int);

create function public.claim_reconciliation_lease(
  p_organization_id bigint,
  p_lease_seconds int default 45
)
returns table (
  owner_token text,
  requested_generation bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_current public.organization_billing%rowtype;
  v_owner text;
begin
  select * into v_current
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- Read the clock after the lock is granted, never before waiting for it.
  v_now := clock_timestamp();

  if v_current.reconciliation_lease_owner is not null
     and v_current.reconciliation_lease_expires_at is not null
     and v_current.reconciliation_lease_expires_at > v_now
  then
    return;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');

  update public.organization_billing
  set reconciliation_lease_owner = v_owner,
      reconciliation_lease_expires_at = v_now + make_interval(secs => greatest(1, p_lease_seconds)),
      billing_sync_last_attempt_at = v_now
  where organization_id = p_organization_id;

  return query select v_owner, v_current.billing_sync_requested;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;

drop function if exists public.write_reconciliation_result(bigint, text, bigint, bigint, text, text, text, timestamptz, boolean);

create function public.write_reconciliation_result(
  p_organization_id bigint,
  p_owner text,
  p_requested_generation bigint,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_subs_completed bigint;
  v_dirty boolean;
begin
  -- Lock first, then read the clock: a lease-timed decision must never be
  -- evaluated against an instant from before waiting for the row lock.
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    return false;
  end if;
  v_now := clock_timestamp();

  if v_row.reconciliation_lease_owner is distinct from p_owner
     or v_row.reconciliation_lease_expires_at is null
     or v_row.reconciliation_lease_expires_at <= v_now
  then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return false;
  end if;

  -- R10-01: activated_at is NOT written here, from any status. This function
  -- observes Stripe's current subscription state; it never observes a payment.
  -- The row's existing activated_at is carried through untouched.
  v_subs_completed := greatest(v_row.billing_sync_completed, p_requested_generation);
  v_dirty := v_row.billing_sync_requested > v_subs_completed
             or (v_row.activated_at is null and v_row.activation_requested > v_row.activation_completed);

  update public.organization_billing
  set stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      status = p_status,
      current_period_end = p_current_period_end,
      cancel_at_period_end = p_cancel_at_period_end,
      last_synced_at = v_now,
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      billing_sync_completed = v_subs_completed,
      billing_sync_last_error = null,
      needs_reconciliation = v_dirty,
      reconciliation_dirty_since = case when v_dirty then coalesce(reconciliation_dirty_since, v_now) else null end,
      checkout_attempt_id = null,
      checkout_attempt_interval = null,
      checkout_attempt_price_id = null,
      checkout_attempt_mode = null,
      checkout_attempt_expires_at = null,
      checkout_owner_token = null,
      checkout_request = null,
      checkout_created_at = null,
      pending_checkout_session_id = null
  where organization_id = p_organization_id;

  return true;
end;
$$;

revoke execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) to service_role;

drop function if exists public.clear_reconciliation_dirty(bigint, text, bigint, bigint);

create function public.clear_reconciliation_dirty(
  p_organization_id bigint,
  p_owner text,
  p_requested_generation bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_subs_completed bigint;
  v_dirty boolean;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found or v_row.reconciliation_lease_owner is distinct from p_owner then
    return false;
  end if;
  v_now := clock_timestamp();

  -- R10 ledger note: this checks owner identity but not lease expiry, which
  -- the round-10 review recorded as a contract inconsistency rather than a
  -- proved defect (a superseding owner is still fenced, because claiming the
  -- lease overwrites the owner token, and newer generations stay pending
  -- through the predicate below). Checking expiry too, for the same reason
  -- every other writer does: "still the owner" and "still holds the lease"
  -- should not be different tests in different functions.
  if v_row.reconciliation_lease_expires_at is null
     or v_row.reconciliation_lease_expires_at <= v_now
  then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return false;
  end if;

  v_subs_completed := greatest(v_row.billing_sync_completed, p_requested_generation);
  v_dirty := v_row.billing_sync_requested > v_subs_completed
             or (v_row.activated_at is null and v_row.activation_requested > v_row.activation_completed);

  update public.organization_billing
  set reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      last_synced_at = v_now,
      billing_sync_completed = v_subs_completed,
      billing_sync_last_error = null,
      needs_reconciliation = v_dirty,
      reconciliation_dirty_since = case when v_dirty then coalesce(reconciliation_dirty_since, v_now) else null end
  where organization_id = p_organization_id;

  return true;
end;
$$;

revoke execute on function public.clear_reconciliation_dirty(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.clear_reconciliation_dirty(bigint, text, bigint) to service_role;
