-- Fifth review round (2026-09-08), part two -- integrating an independent
-- parallel implementation's generation-counter and staleness-recovery
-- model into this project's own reconciliation lease. A FORWARD migration
-- on top of 20260908100000, not an edit of anything already applied.
--
-- GAP 4 (the important one) -- an event arriving DURING a reconciliation
-- was silently lost. The lease (20260907210000, hardened by 20260907230000)
-- gives real mutual exclusion, and marks the organization dirty from the
-- moment a lease is claimed, so an ABANDONED reconciliation is always
-- recoverable. But a COMPLETED one unconditionally cleared
-- needs_reconciliation -- including the dirty flag set moments earlier by
-- a different, newer webhook that failed to claim the lease. Concretely:
--
--   1. webhook A claims the lease and calls stripe.subscriptions.list()
--   2. Stripe state changes; webhook B is delivered for that change
--   3. B fails to claim (A holds it) and durably sets needs_reconciliation
--   4. A finishes writing the state it read at step 1 and clears the flag
--
-- Nothing is left anywhere recording that B ever happened, and the row now
-- holds pre-step-2 state that no future event will correct. The lease
-- prevented the write-write race but not this read-staleness one.
--
-- Fixed with a monotonic generation pair. Every entry point calls
-- request_billing_reconciliation FIRST, durably incrementing
-- billing_sync_requested before any Stripe call. claim_reconciliation_lease
-- reports the generation it observed, and a completing write clears the
-- dirty flag ONLY if billing_sync_requested has not advanced past that
-- observation -- so in the sequence above, A's write records
-- billing_sync_completed = 1 but leaves needs_reconciliation true, because
-- requested is already 2. B's event is then reconciled by the sweep. A
-- write is now the answer to "was every request I knew about satisfied,"
-- not merely "did I finish."
--
-- GAP 5 -- recovery depended entirely on the dirty flag ever being set.
-- Every path that sets it runs inside this application; a Stripe event
-- this app never received AT ALL (a webhook endpoint misconfiguration, a
-- delivery dropped after Stripe exhausted its finite retries, an
-- out-of-band change made in the Stripe Dashboard) leaves nothing dirty
-- and is therefore invisible to the sweep forever. get_billing_
-- reconciliation_candidates adds a second, independent trigger: an
-- organization whose local state has simply not been checked against
-- Stripe for a while is a candidate regardless of any flag. Convergence
-- now rests on elapsed time, which this app can always observe, rather
-- than on having successfully received a notification.
--
-- Also folded in: billing_sync_last_attempt_at gives the sweep a per-
-- organization back-off so one permanently failing organization cannot
-- monopolize a run, and billing_sync_last_error keeps the last failure
-- reason somewhere durable instead of only in a log line.
alter table public.organization_billing
  add column billing_sync_requested bigint not null default 0,
  add column billing_sync_completed bigint not null default 0,
  add column billing_sync_last_attempt_at timestamptz,
  add column billing_sync_last_error text;

-- The sweep's candidate scan (below) filters on these three together. The
-- previous partial index covered only `where needs_reconciliation`, which
-- no longer describes the whole candidate set.
create index organization_billing_sync_candidates_idx
  on public.organization_billing (billing_sync_last_attempt_at, organization_id)
  where stripe_customer_id is not null;

-- Records that reconciliation is WANTED, durably, before any Stripe call
-- and independently of whether a lease can be claimed. This is what makes
-- a request that loses the lease race survive it: the generation is
-- already committed, so whoever currently holds the lease cannot mark the
-- organization clean without also satisfying this request.
create function public.request_billing_reconciliation(p_organization_id bigint)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_requested bigint;
begin
  update public.organization_billing
  set billing_sync_requested = billing_sync_requested + 1,
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
  where organization_id = p_organization_id
  returning billing_sync_requested into v_requested;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  return v_requested;
end;
$$;

revoke execute on function public.request_billing_reconciliation(bigint) from public, anon, authenticated;
grant execute on function public.request_billing_reconciliation(bigint) to service_role;

-- Return type changes (the observed generation now comes back alongside
-- the owner token), so this is a drop and create rather than a
-- create-or-replace. Behaviour is otherwise exactly 20260907230000's:
-- exclusive, expiring, and dirty from the moment of a successful claim so
-- that a process-level kill still leaves the organization findable.
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

  -- The generation observed BEFORE this reconciliation reads Stripe. Any
  -- request committed after this point leaves billing_sync_requested
  -- higher than this value, which is exactly what stops the completing
  -- write below from marking the organization clean.
  return query select v_owner, v_current.billing_sync_requested;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;

-- Signatures gain p_requested_generation, so these three are drops and
-- creates. Each keeps its previous CAS discipline (the write only lands if
-- this caller still owns the lease) and adds the generation test that
-- decides whether the dirty flag may be cleared.
drop function if exists public.write_reconciliation_result(bigint, text, text, text, text, timestamptz, boolean);
drop function if exists public.write_activation(bigint, text);
drop function if exists public.clear_reconciliation_dirty(bigint, text);

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
  v_applied boolean;
begin
  -- Lock the row EXPLICITLY before the timed UPDATE below. Without
  -- this, the UPDATE's own `lease_expires_at > clock_timestamp()` qual is
  -- evaluated during the scan -- BEFORE waiting behind another
  -- transaction's lock -- and then applied once the wait ends, by which
  -- time the lease may have expired. Locking first collapses that window.
  -- Caught for real by scripts/verify-local-database.mjs, which blocks a
  -- second connection behind a genuine lock and lets the lease lapse
  -- during the wait.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      status = p_status,
      current_period_end = p_current_period_end,
      cancel_at_period_end = p_cancel_at_period_end,
      last_synced_at = clock_timestamp(),
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      billing_sync_completed = greatest(billing_sync_completed, p_requested_generation),
      billing_sync_last_error = null,
      -- The whole point of the generation pair: an UPDATE's right-hand
      -- side sees the row as it stands NOW, so this compares whatever
      -- billing_sync_requested has reached against what this reconciler
      -- observed before it read Stripe. A request that arrived in between
      -- keeps the organization dirty, and the sweep re-derives it.
      needs_reconciliation = (billing_sync_requested > p_requested_generation),
      reconciliation_dirty_since = case
        when billing_sync_requested > p_requested_generation
          then coalesce(reconciliation_dirty_since, clock_timestamp())
        else null
      end,
      checkout_attempt_id = null,
      checkout_attempt_interval = null,
      checkout_attempt_price_id = null,
      checkout_attempt_mode = null,
      checkout_attempt_expires_at = null,
      checkout_owner_token = null,
      checkout_request = null,
      checkout_created_at = null,
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

revoke execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) to service_role;

create function public.write_activation(
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
  v_applied boolean;
begin
  -- Lock the row EXPLICITLY before the timed UPDATE below. Without
  -- this, the UPDATE's own `lease_expires_at > clock_timestamp()` qual is
  -- evaluated during the scan -- BEFORE waiting behind another
  -- transaction's lock -- and then applied once the wait ends, by which
  -- time the lease may have expired. Locking first collapses that window.
  -- Caught for real by scripts/verify-local-database.mjs, which blocks a
  -- second connection behind a genuine lock and lets the lease lapse
  -- during the wait.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set activated_at = coalesce(activated_at, clock_timestamp()),
      reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      billing_sync_completed = greatest(billing_sync_completed, p_requested_generation),
      needs_reconciliation = (billing_sync_requested > p_requested_generation),
      reconciliation_dirty_since = case
        when billing_sync_requested > p_requested_generation
          then coalesce(reconciliation_dirty_since, clock_timestamp())
        else null
      end
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

revoke execute on function public.write_activation(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.write_activation(bigint, text, bigint) to service_role;

-- "I definitively checked Stripe and there is genuinely nothing to
-- reconcile" -- distinct from release_reconciliation_lease, which is the
-- error/abandonment path and always re-marks the organization dirty (see
-- 20260907240000). last_synced_at is now stamped here too: a confirmed-
-- clean check is a real check, and without it the staleness scan below
-- would re-list Stripe for the same organization on every single run.
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
  v_applied boolean;
begin
  -- Lock the row EXPLICITLY before the timed UPDATE below. Without
  -- this, the UPDATE's own `lease_expires_at > clock_timestamp()` qual is
  -- evaluated during the scan -- BEFORE waiting behind another
  -- transaction's lock -- and then applied once the wait ends, by which
  -- time the lease may have expired. Locking first collapses that window.
  -- Caught for real by scripts/verify-local-database.mjs, which blocks a
  -- second connection behind a genuine lock and lets the lease lapse
  -- during the wait.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      last_synced_at = clock_timestamp(),
      billing_sync_completed = greatest(billing_sync_completed, p_requested_generation),
      billing_sync_last_error = null,
      needs_reconciliation = (billing_sync_requested > p_requested_generation),
      reconciliation_dirty_since = case
        when billing_sync_requested > p_requested_generation
          then coalesce(reconciliation_dirty_since, clock_timestamp())
        else null
      end
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
  returning true into v_applied;

  return coalesce(v_applied, false);
end;
$$;

revoke execute on function public.clear_reconciliation_dirty(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.clear_reconciliation_dirty(bigint, text, bigint) to service_role;

-- Records why a reconciliation failed, and releases the lease so a retry
-- need not wait out its expiry. Deliberately does NOT clear the dirty
-- flag or advance billing_sync_completed -- a failure is unfinished work.
create function public.fail_billing_reconciliation(
  p_organization_id bigint,
  p_owner text,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_applied boolean;
begin
  -- Lock the row EXPLICITLY before the timed UPDATE below. Without
  -- this, the UPDATE's own `lease_expires_at > clock_timestamp()` qual is
  -- evaluated during the scan -- BEFORE waiting behind another
  -- transaction's lock -- and then applied once the wait ends, by which
  -- time the lease may have expired. Locking first collapses that window.
  -- Caught for real by scripts/verify-local-database.mjs, which blocks a
  -- second connection behind a genuine lock and lets the lease lapse
  -- during the wait.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      billing_sync_last_error = left(p_error, 1000)
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
  returning true into v_applied;

  update public.organization_billing
  set needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, clock_timestamp())
  where organization_id = p_organization_id;

  return coalesce(v_applied, false);
end;
$$;

revoke execute on function public.fail_billing_reconciliation(bigint, text, text) from public, anon, authenticated;
grant execute on function public.fail_billing_reconciliation(bigint, text, text) to service_role;

-- Unchanged in meaning from 20260907210000, re-created here only to adopt
-- the same lock-then-check discipline as every other lease-timed write
-- above: its expiry qual has to be evaluated after any wait for the row
-- lock, not during the scan that precedes the wait.
create or replace function public.renew_reconciliation_lease(
  p_organization_id bigint,
  p_owner text,
  p_lease_seconds int default 45
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set reconciliation_lease_expires_at =
        clock_timestamp() + make_interval(secs => greatest(1, least(300, p_lease_seconds)))
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
    and reconciliation_lease_expires_at > clock_timestamp();

  return found;
end;
$$;

revoke execute on function public.renew_reconciliation_lease(bigint, text, int) from public, anon, authenticated;
grant execute on function public.renew_reconciliation_lease(bigint, text, int) to service_role;

-- The sweep's candidate set. Two independent reasons to reconcile:
-- something explicitly asked for it (the dirty flag, or an unsatisfied
-- generation), or nobody has checked in long enough that a silently
-- missed event would by now be plausible. Only organizations that
-- actually have a Stripe customer are ever candidates -- there is nothing
-- at Stripe to reconcile against otherwise, and an organization on its own
-- pre-signup trial must not cost a Stripe API call every sweep.
--
-- Rows whose lease is currently held by a live reconciler are excluded
-- (claiming would only fail), and every candidate must have gone at least
-- a minute since its own last attempt, so a persistently failing
-- organization rotates to the back instead of consuming the whole run.
create function public.get_billing_reconciliation_candidates(
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
         or b.last_synced_at is null
         or b.last_synced_at < clock_timestamp() - make_interval(secs => greatest(300, p_stale_seconds)))
  order by b.billing_sync_last_attempt_at nulls first, b.organization_id
  limit least(200, greatest(1, p_limit));
$$;

revoke execute on function public.get_billing_reconciliation_candidates(int, int) from public, anon, authenticated;
grant execute on function public.get_billing_reconciliation_candidates(int, int) to service_role;
