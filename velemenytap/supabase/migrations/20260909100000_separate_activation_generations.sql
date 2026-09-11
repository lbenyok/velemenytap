-- Round 9 independent review, finding R9-02 (P1). A forward migration on top
-- of 20260908110000; nothing already applied is edited.
--
-- THE DEFECT. 20260908110000 introduced a monotonic generation pair so that a
-- reconciliation could only mark an organization clean if it had satisfied
-- every request it knew about. That is correct as far as it goes -- but the
-- pair counts REQUESTS, not KINDS OF WORK, and two genuinely different
-- obligations were sharing it:
--
--   * refreshing subscription state from Stripe (write_reconciliation_result)
--   * persisting the fact that a payment has genuinely succeeded, i.e.
--     activated_at (write_activation)
--
-- Either writer could therefore mark generations complete that only the OTHER
-- kind of work could have discharged. The review reproduced both directions
-- against real PostgreSQL:
--
--   1. A subscription refresh writes an older `past_due` observation while a
--      newer request arrives, correctly leaving requested=2 completed=1 dirty.
--      An invoice activation then claims generation 3 and writes ONLY
--      activated_at -- and the row becomes requested=completed=3, clean, with
--      status still the stale `past_due`. The pending refresh was silently
--      consumed by work that never looked at the subscription.
--
--   2. An activation request loses the lease and stays pending. A later
--      subscription sweep claims a newer generation, refreshes the status, and
--      marks the row clean with activated_at still null. If invoice redelivery
--      is exhausted, a previously-paying organization keeps a grandfathered
--      grant it should have lost.
--
-- THE FIX, in two parts.
--
-- Part one: give activation its own counter pair. A writer may now only
-- advance the counter for the work it actually performed, and the dirty flag
-- is the disjunction -- clean requires BOTH obligations satisfied. This is the
-- structural correction: a generic generation number cannot stand in for
-- durable information about which obligation is outstanding.
--
-- Part two, so that part one cannot deadlock: the activation obligation is
-- discharged by whichever writer first obtains the evidence for it. A Stripe
-- subscription in status `active` means its first invoice was paid, which is
-- exactly what activated_at records ("the first-ever observed transition to
-- Stripe subscription status 'active'" -- migration 20260907180000's own
-- definition). So write_reconciliation_result now sets activated_at when it
-- writes an `active` status, from evidence it already holds and with no extra
-- Stripe call. Without this, scenario 2's organization would stay dirty
-- forever: the sweep would keep selecting it and keep being unable to satisfy
-- an activation obligation that only an invoice event could clear.
--
-- Once activated_at is set the activation obligation is permanently moot --
-- it is a one-way latch, so there is nothing further any writer could do --
-- which is why the dirty predicate below tests it rather than the counters
-- alone.
alter table public.organization_billing
  add column activation_requested bigint not null default 0,
  add column activation_completed bigint not null default 0;

-- Records that an ACTIVATION is wanted, durably, before any Stripe call --
-- the activation-side counterpart to request_billing_reconciliation.
create function public.request_billing_activation(p_organization_id bigint)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_requested bigint;
begin
  update public.organization_billing
  set activation_requested = activation_requested + 1,
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
  where organization_id = p_organization_id
  returning activation_requested into v_requested;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  return v_requested;
end;
$$;

revoke execute on function public.request_billing_activation(bigint) from public, anon, authenticated;
grant execute on function public.request_billing_activation(bigint) to service_role;

-- Return type changes (the activation generation now comes back alongside the
-- subscription one), so drop and create. Behaviour is otherwise 20260908110000's.
drop function if exists public.claim_reconciliation_lease(bigint, int);

create function public.claim_reconciliation_lease(
  p_organization_id bigint,
  p_lease_seconds int default 45
)
returns table (
  owner_token text,
  requested_generation bigint,
  activation_generation bigint
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
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set reconciliation_lease_owner = v_owner,
      reconciliation_lease_expires_at = v_now + make_interval(secs => greatest(1, least(300, p_lease_seconds))),
      billing_sync_last_attempt_at = v_now,
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
  where organization_id = p_organization_id;

  -- BOTH generations observed before this reconciliation reads Stripe. A
  -- write may only ever clear the obligation matching the work it did.
  return query select v_owner, v_current.billing_sync_requested, v_current.activation_requested;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;

drop function if exists public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean);
drop function if exists public.write_activation(bigint, text, bigint);
drop function if exists public.clear_reconciliation_dirty(bigint, text, bigint);

create function public.write_reconciliation_result(
  p_organization_id bigint,
  p_owner text,
  p_requested_generation bigint,
  p_activation_generation bigint,
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
  v_activated_at timestamptz;
  v_subs_completed bigint;
  v_act_completed bigint;
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

  -- Part two of the fix: an `active` subscription is itself the evidence that
  -- a payment has succeeded, so this write discharges the activation
  -- obligation too rather than leaving it for an invoice event that may never
  -- be redelivered. One-way latch -- never overwritten once set.
  v_activated_at := v_row.activated_at;
  if v_activated_at is null and p_status = 'active' then
    v_activated_at := v_now;
  end if;

  v_subs_completed := greatest(v_row.billing_sync_completed, p_requested_generation);
  v_act_completed := case
    when v_activated_at is not null then greatest(v_row.activation_completed, p_activation_generation)
    else v_row.activation_completed
  end;
  v_dirty := v_row.billing_sync_requested > v_subs_completed
             or (v_activated_at is null and v_row.activation_requested > v_act_completed);

  update public.organization_billing
  set stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      status = p_status,
      current_period_end = p_current_period_end,
      cancel_at_period_end = p_cancel_at_period_end,
      activated_at = v_activated_at,
      last_synced_at = v_now,
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      billing_sync_completed = v_subs_completed,
      activation_completed = v_act_completed,
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

revoke execute on function public.write_reconciliation_result(bigint, text, bigint, bigint, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.write_reconciliation_result(bigint, text, bigint, bigint, text, text, text, timestamptz, boolean) to service_role;

-- Activation now advances ONLY the activation counter. It knows nothing about
-- the organization's current subscription state and must not claim to have
-- refreshed it -- which is precisely scenario 1 of the finding.
create function public.write_activation(
  p_organization_id bigint,
  p_owner text,
  p_requested_generation bigint,
  p_activation_generation bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_activated_at timestamptz;
  v_act_completed bigint;
  v_dirty boolean;
begin
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

  v_activated_at := coalesce(v_row.activated_at, v_now);
  v_act_completed := greatest(v_row.activation_completed, p_activation_generation);
  -- Deliberately NOT advancing billing_sync_completed: nothing here observed
  -- the subscription, so any outstanding refresh stays outstanding.
  v_dirty := v_row.billing_sync_requested > v_row.billing_sync_completed
             or (v_activated_at is null and v_row.activation_requested > v_act_completed);

  update public.organization_billing
  set activated_at = v_activated_at,
      activation_completed = v_act_completed,
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      needs_reconciliation = v_dirty,
      reconciliation_dirty_since = case when v_dirty then coalesce(reconciliation_dirty_since, v_now) else null end
  where organization_id = p_organization_id;

  return true;
end;
$$;

revoke execute on function public.write_activation(bigint, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.write_activation(bigint, text, bigint, bigint) to service_role;

-- "I definitively checked Stripe and there is genuinely nothing to reconcile."
-- Confirms the SUBSCRIPTION obligation only; an outstanding activation is
-- still outstanding, for the same reason as above.
create function public.clear_reconciliation_dirty(
  p_organization_id bigint,
  p_owner text,
  p_requested_generation bigint,
  p_activation_generation bigint
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

revoke execute on function public.clear_reconciliation_dirty(bigint, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.clear_reconciliation_dirty(bigint, text, bigint, bigint) to service_role;

-- The candidate scan must see an outstanding ACTIVATION as work too, or
-- scenario 2's organization is never selected for recovery.
create or replace function public.get_billing_reconciliation_candidates(
  p_limit int default 50,
  p_stale_seconds int default 3600
)
returns table (
  organization_id bigint,
  stripe_customer_id text
)
language sql
security invoker
set search_path = ''
as $$
  select b.organization_id, b.stripe_customer_id
  from public.organization_billing b
  where b.stripe_customer_id is not null
    and (b.reconciliation_lease_expires_at is null
         or b.reconciliation_lease_expires_at <= clock_timestamp())
    and (b.billing_sync_last_attempt_at is null
         or b.billing_sync_last_attempt_at < clock_timestamp() - interval '1 minute')
    and (b.needs_reconciliation
         or b.billing_sync_requested > b.billing_sync_completed
         or (b.activated_at is null and b.activation_requested > b.activation_completed)
         or b.last_synced_at is null
         or b.last_synced_at < clock_timestamp() - make_interval(secs => greatest(300, p_stale_seconds)))
  order by b.billing_sync_last_attempt_at nulls first, b.organization_id
  limit least(200, greatest(1, p_limit));
$$;

revoke execute on function public.get_billing_reconciliation_candidates(int, int) from public, anon, authenticated;
grant execute on function public.get_billing_reconciliation_candidates(int, int) to service_role;
