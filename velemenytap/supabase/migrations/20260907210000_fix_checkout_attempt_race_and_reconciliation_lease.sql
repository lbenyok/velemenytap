-- Fourth independent review (2026-09-07). Migration 20260907200000 has
-- already been applied to the isolated test project -- this is a forward
-- migration correcting it, not a rewrite (that migration is no longer
-- "never applied anywhere," so editing it in place would reproduce exactly
-- the bookkeeping-drift risk this project has already been burned by once
-- -- see DECISIONS.md).
--
-- FINDING 1 (HIGH) -- wrong-plan Checkout race: claim_checkout_attempt's
-- "mint a fresh attempt" branch overwrote checkout_attempt_interval/
-- price_id/mode with the NEW request's values but left
-- pending_checkout_session_id untouched (still pointing at the SUPERSEDED
-- attempt's session). A second, concurrent caller's own fresh `select ...
-- for update` could therefore observe an internally-inconsistent row --
-- new interval, old session id -- and features/billing/actions.ts, trusting
-- that pairing, could hand back a monthly Session's URL for a yearly
-- request. Fixed by clearing pending_checkout_session_id in the SAME
-- statement that changes what the attempt is for, so the stored row can
-- never pair fresher metadata with a stale session pointer. The
-- superseded session is still returned to the caller for reconciliation,
-- correctly paired with the OLD (pre-update) interval/price/mode it
-- actually belongs to -- both captured from the same v_row snapshot taken
-- before the update runs. features/billing/actions.ts additionally
-- verifies the reused Session's own Stripe-side price (via its line
-- items), never trusting this row's bookkeeping alone, as defense in
-- depth independent of this fix.
--
-- FINDING 9 -- lease duration: renew_checkout_attempt lets a request prove
-- it still owns its attempt and extend the claim at a natural checkpoint
-- (after customer resolution, before the Checkout Session create call),
-- rather than relying on one static duration being provably longer than
-- every possible Stripe round trip.
--
-- FINDING 3 (HIGH) -- the previous billing_sync_seq design fenced on CLAIM
-- ORDER, not on the freshness of the Stripe state actually observed --
-- an independent adversarial review demonstrated directly that a request
-- claiming seq=1 can execute (and read genuinely fresher Stripe state)
-- AFTER a request that claimed seq=2 has already written, and the
-- seq-fencing model discards the fresher read purely because of claim
-- order, with nothing left to ever correct it. Replaced entirely with an
-- exclusive, expiring, durable RECONCILIATION LEASE: only one reconciler
-- may hold an organization's lease at a time (claimed BEFORE any Stripe
-- call, released or renewed explicitly), so there is no window where two
-- readers can observe Stripe state concurrently and race to write at all
-- -- mutual exclusion, not optimistic fencing after the fact. A contender
-- that cannot claim the lease -- or that claims it but then loses it
-- before writing (a crash, an expired renewal) -- never silently assumes
-- someone else's write already covers it: needs_reconciliation is set
-- durably in the SAME statement, so a later retry (Stripe's own, a
-- following event, or the scheduled reconciliation sweep --
-- features/billing/reconcile.ts) always eventually re-derives and writes
-- the current truth. See DECISIONS.md for the full incident.
--
-- FINDING 4 -- private.billing_anomalies gives duplicate-active-
-- subscription detection (app/api/webhooks/stripe/route.ts's
-- pickCurrentSubscription) somewhere durable to record what it found,
-- rather than only a console.error line nothing keeps.
alter table public.organization_billing
  drop column billing_sync_seq;

drop function if exists public.claim_billing_sync(bigint);

alter table public.organization_billing
  add column reconciliation_lease_owner text,
  add column reconciliation_lease_expires_at timestamptz,
  add column needs_reconciliation boolean not null default false,
  add column reconciliation_dirty_since timestamptz;

-- A dirty organization is always worth finding fast -- the scheduled sweep
-- (features/billing/reconcile.ts) scans exactly this predicate.
create index organization_billing_needs_reconciliation_idx
  on public.organization_billing (organization_id)
  where needs_reconciliation;

create table private.billing_anomalies (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default clock_timestamp()
);

create index billing_anomalies_organization_id_idx
  on private.billing_anomalies (organization_id, detected_at desc);

-- Not exposed to PostgREST (private schema), no RLS policies for anon/
-- authenticated -- same pattern as private.alert_email_log. Only the
-- admin client (service_role, which bypasses RLS at the connection-role
-- level) ever reads or writes it.
alter table private.billing_anomalies enable row level security;

grant select, insert on private.billing_anomalies to service_role;

-- Fixed re-implementation -- see this file's own header comment (Finding
-- 1) for exactly what changed and why. Signature unchanged from
-- 20260907200000's version, so this create-or-replace is a safe drop-in.
create or replace function public.claim_checkout_attempt(
  p_organization_id bigint,
  p_interval text,
  p_price_id text,
  p_mode text,
  p_claim_seconds int default 150
)
returns table (
  attempt_id text,
  is_new_attempt boolean,
  existing_session_id text,
  existing_interval text,
  existing_price_id text,
  existing_mode text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.organization_billing%rowtype;
  v_new_attempt_id text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  if v_row.checkout_attempt_id is not null
     and v_row.checkout_attempt_expires_at is not null
     and v_row.checkout_attempt_expires_at > v_now
  then
    return query select
      v_row.checkout_attempt_id, false,
      v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
      v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode;
    return;
  end if;

  v_new_attempt_id := encode(extensions.gen_random_bytes(16), 'hex');

  -- Finding 1's actual fix: pending_checkout_session_id is cleared HERE,
  -- in the same statement that changes interval/price/mode -- the stored
  -- row can never again pair a stale session with fresher attempt
  -- metadata, for any subsequent caller's own read.
  update public.organization_billing
  set checkout_attempt_id = v_new_attempt_id,
      checkout_attempt_interval = p_interval,
      checkout_attempt_price_id = p_price_id,
      checkout_attempt_mode = p_mode,
      checkout_attempt_expires_at = v_now + (p_claim_seconds || ' seconds')::interval,
      pending_checkout_session_id = null
  where organization_id = p_organization_id;

  return query select
    v_new_attempt_id, true,
    v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
    v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode;
end;
$$;

-- Finding 9: proves continued ownership of an in-flight attempt and pushes
-- its expiry out further, at a natural checkpoint the caller controls
-- (after customer resolution, before the Checkout Session creation call)
-- -- so correctness stops depending on any single static duration being
-- provably longer than every possible Stripe round trip. Returns false
-- (checked by the caller, which must then abort rather than proceed) if
-- the attempt has already expired or been superseded.
create or replace function public.renew_checkout_attempt(
  p_organization_id bigint,
  p_attempt_id text,
  p_claim_seconds int default 150
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set checkout_attempt_expires_at = clock_timestamp() + (p_claim_seconds || ' seconds')::interval
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_attempt_expires_at > clock_timestamp()
  returning true;
$$;

revoke execute on function public.renew_checkout_attempt(bigint, text, int) from public, anon, authenticated;
grant execute on function public.renew_checkout_attempt(bigint, text, int) to service_role;

-- Finding 3: claims EXCLUSIVE reconciliation rights for an organization --
-- mutual exclusion, not optimistic fencing. Returns an opaque owner token
-- if claimed, or NULL if another reconciler currently holds an unexpired
-- lease. Failing to claim NEVER means "safe to assume someone else has it
-- covered" on its own -- needs_reconciliation is set durably, in the same
-- statement, so this organization is never silently dropped: a later
-- retry (Stripe's own webhook retry, a subsequent event, or the scheduled
-- sweep in features/billing/reconcile.ts) will find it and reconcile.
create or replace function public.claim_reconciliation_lease(
  p_organization_id bigint,
  p_lease_seconds int default 45
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
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

  if v_current.reconciliation_lease_owner is not null
     and v_current.reconciliation_lease_expires_at is not null
     and v_current.reconciliation_lease_expires_at > v_now
  then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return null;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set reconciliation_lease_owner = v_owner,
      reconciliation_lease_expires_at = v_now + (p_lease_seconds || ' seconds')::interval
  where organization_id = p_organization_id;

  return v_owner;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;

-- Finding 9's equivalent for reconciliation itself: proves continued
-- ownership and extends the lease at a checkpoint (e.g. before a slow
-- Stripe list() call), the same reasoning as renew_checkout_attempt.
create or replace function public.renew_reconciliation_lease(
  p_organization_id bigint,
  p_owner text,
  p_lease_seconds int default 45
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set reconciliation_lease_expires_at = clock_timestamp() + (p_lease_seconds || ' seconds')::interval
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
    and reconciliation_lease_expires_at > clock_timestamp()
  returning true;
$$;

revoke execute on function public.renew_reconciliation_lease(bigint, text, int) from public, anon, authenticated;
grant execute on function public.renew_reconciliation_lease(bigint, text, int) to service_role;

-- Applies a canonically-derived billing state, CAS'd on still owning the
-- lease claimed before the Stripe reads that produced it. If the lease
-- was lost in the meantime (expired, or reclaimed by a newer attempt),
-- this NEVER silently discards the event -- it durably marks the
-- organization dirty again in the same call, exactly like a failed claim,
-- so nothing depends on an assumption that whoever holds the lease now
-- will produce an equivalent result. Returns true only when this specific
-- write actually landed.
create or replace function public.write_reconciliation_result(
  p_organization_id bigint,
  p_owner text,
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
  v_applied boolean;
begin
  update public.organization_billing
  set stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      status = p_status,
      current_period_end = p_current_period_end,
      cancel_at_period_end = p_cancel_at_period_end,
      last_synced_at = clock_timestamp(),
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      needs_reconciliation = false,
      reconciliation_dirty_since = null,
      checkout_attempt_id = null,
      checkout_attempt_interval = null,
      checkout_attempt_price_id = null,
      checkout_attempt_mode = null,
      checkout_attempt_expires_at = null,
      pending_checkout_session_id = null
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
    and reconciliation_lease_expires_at > clock_timestamp()
  returning true into v_applied;

  if v_applied is distinct from true then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
    where organization_id = p_organization_id;
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public.write_reconciliation_result(bigint, text, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.write_reconciliation_result(bigint, text, text, text, text, timestamptz, boolean) to service_role;

-- Sets activated_at (Finding 5/11's invoice.paid path) under the SAME
-- lease discipline as write_reconciliation_result, so an invoice.paid
-- event competing with a concurrent subscription-sync for the same
-- organization is also mutually excluded, not just independently
-- fenced. Idempotent regardless (only ever transitions null -> a value),
-- but taking the lease keeps every write to this row going through one
-- single ownership discipline rather than two different ones.
create or replace function public.write_activation(
  p_organization_id bigint,
  p_owner text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_applied boolean;
begin
  update public.organization_billing
  set activated_at = coalesce(activated_at, clock_timestamp()),
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      needs_reconciliation = false,
      reconciliation_dirty_since = null
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
    and reconciliation_lease_expires_at > clock_timestamp()
  returning true into v_applied;

  if v_applied is distinct from true then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
    where organization_id = p_organization_id;
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public.write_activation(bigint, text) from public, anon, authenticated;
grant execute on function public.write_activation(bigint, text) to service_role;

-- Explicit cleanup for a reconciliation attempt that claimed the lease but
-- then hit an unexpected error before writing (a thrown Stripe call, a
-- crashed request that a `finally` still got to run for) -- releases the
-- lease immediately (rather than waiting out its own expiry) AND marks
-- the organization dirty, so nothing sits both locked and forgotten.
create or replace function public.release_reconciliation_lease(
  p_organization_id bigint,
  p_owner text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_released boolean;
begin
  update public.organization_billing
  set reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
  returning true into v_released;

  update public.organization_billing
  set needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
  where organization_id = p_organization_id;

  return coalesce(v_released, false);
end;
$$;

revoke execute on function public.release_reconciliation_lease(bigint, text) from public, anon, authenticated;
grant execute on function public.release_reconciliation_lease(bigint, text) to service_role;
