-- Round 9 independent review, findings R9-03 and R9-04 (both P2). Forward
-- migration on top of 20260908120000.
--
-- R9-04 -- THE BACKFILL INVENTED A KEY AND CALLED IT A REPLAY.
--
-- 20260908120000 gave interrupted legacy rows a RANDOM creation identity and
-- dated it from coalesce(checkout_created_at, created_at). For a recent
-- organization that yields retry_safe = true, so the caller skips recovery and
-- creates under the new random key -- which is not a replay of anything. The
-- previous billing version used a DETERMINISTIC key, `customer-create:org-ID`,
-- so if it had already created a Customer without recording it, Stripe would
-- not deduplicate the new call and a duplicate Customer results.
--
-- It also only touched rows that had a checkout_attempt_id. Commit 241572f
-- resolved the Stripe customer BEFORE claiming a checkout attempt, so an
-- interruption in that window leaves no attempt at all -- and those rows were
-- excluded, then got a fresh random identity on their next claim, with the
-- same consequence. Absent local checkout state is not evidence that the old
-- code never called Stripe.
--
-- Fixed by preserving the identity that actually existed. Every unresolved row
-- is stamped with the sentinel `legacy-org-<id>`, which
-- features/billing/actions.ts maps back to the original
-- `customer-create:org-<id>` key -- so a replay inside the retention window is
-- a genuine replay of the original request. The timestamp becomes the
-- organization's own created_at: the earliest moment any Customer could have
-- been created for it, which both bounds the recovery enumeration honestly and
-- makes retry_safe mean what it says. A long-standing organization is
-- correctly NOT retry-safe and goes through the canonical enumeration; a
-- recently created one correctly replays the real legacy key.
--
-- R9-03 -- ROTATION COULD RACE AN IN-FLIGHT CREATION.
--
-- The retry-safe window is a boundary in time, and two requests can sit on
-- opposite sides of it. At 22h59m59s request A reads retry_safe = true and
-- starts creating under the frozen key. At 23h00m00s request B reads
-- retry_safe = false, performs a completely accurate list enumeration, sees no
-- Customer -- because A's has not been created yet -- rotates the identity and
-- creates its own. Both calls succeed. The database correctly stops A from
-- overwriting B's persisted Customer, but only after both external objects
-- exist. A fresh list cannot establish that a concurrent request will not
-- create an object a moment later; nothing owned the decision.
--
-- Fixed by giving customer creation the same operation lease the checkout
-- attempt already has. A claim grants short-lived ownership; a second caller
-- is told to stand down rather than racing; and rotation -- the step that
-- decides the old key is dead -- is refused while anyone else holds a live
-- lease. This closes the window between "I looked" and "I acted", which is the
-- only place the race lives.
alter table public.organization_billing
  add column customer_creation_lease_owner text,
  add column customer_creation_lease_expires_at timestamptz;

-- R9-04's corrective backfill. Deliberately covers EVERY unresolved row, not
-- only those with a checkout attempt.
update public.organization_billing b
set customer_creation_id = 'legacy-org-' || b.organization_id::text,
    customer_creation_started_at = coalesce(o.created_at, b.created_at)
from public.organizations o
where o.id = b.organization_id
  and b.stripe_customer_id is null;

drop function if exists public.claim_stripe_customer_creation(bigint);
drop function if exists public.rotate_stripe_customer_creation(bigint, text);

-- Claims the OPERATION LEASE over this organization's customer creation, and
-- mints the creation identity once if none exists.
--
-- owner_token null means another creation is in flight: stand down rather than
-- racing it. That is the whole of R9-03's fix -- the previous version handed
-- every concurrent caller the same identity and let them all proceed, which is
-- safe while the frozen key is alive and unsafe the moment one of them decides
-- it is dead.
create function public.claim_stripe_customer_creation(
  p_organization_id bigint,
  p_lease_seconds int default 150
)
returns table (
  customer_id text,
  creation_id text,
  started_at timestamptz,
  retry_safe boolean,
  owner_token text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_owner text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- Clock read after the lock is granted, never before waiting for it.
  v_now := clock_timestamp();

  if v_row.stripe_customer_id is not null then
    return query select v_row.stripe_customer_id, null::text, null::timestamptz, false, null::text;
    return;
  end if;

  if v_row.customer_creation_lease_owner is not null
     and v_row.customer_creation_lease_expires_at is not null
     and v_row.customer_creation_lease_expires_at > v_now
  then
    return query select
      null::text, v_row.customer_creation_id, v_row.customer_creation_started_at, false, null::text;
    return;
  end if;

  if v_row.customer_creation_id is null then
    update public.organization_billing
    set customer_creation_id = encode(extensions.gen_random_bytes(16), 'hex'),
        customer_creation_started_at = v_now
    where organization_id = p_organization_id
    returning * into v_row;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set customer_creation_lease_owner = v_owner,
      customer_creation_lease_expires_at = v_now + make_interval(secs => greatest(1, least(600, p_lease_seconds)))
  where organization_id = p_organization_id
  returning * into v_row;

  return query select
    null::text,
    v_row.customer_creation_id,
    v_row.customer_creation_started_at,
    coalesce(v_row.customer_creation_started_at > v_now - interval '23 hours', false),
    v_owner;
end;
$$;

revoke execute on function public.claim_stripe_customer_creation(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_stripe_customer_creation(bigint, int) to service_role;

-- Retires a dead creation identity and mints a replacement. Now requires the
-- caller to hold the creation lease, so it cannot run while a different
-- request is mid-create under the identity it is about to declare dead.
create function public.rotate_stripe_customer_creation(
  p_organization_id bigint,
  p_creation_id text,
  p_owner_token text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_new text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  v_now := clock_timestamp();

  if v_row.stripe_customer_id is not null then
    return null;
  end if;
  if v_row.customer_creation_id is distinct from p_creation_id then
    return null;
  end if;
  -- R9-03: only the holder of the live creation lease may retire a key.
  if v_row.customer_creation_lease_owner is distinct from p_owner_token
     or v_row.customer_creation_lease_expires_at is null
     or v_row.customer_creation_lease_expires_at <= v_now
  then
    return null;
  end if;
  if coalesce(v_row.customer_creation_started_at > v_now - interval '23 hours', false) then
    return null;
  end if;

  v_new := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set customer_creation_id = v_new,
      customer_creation_started_at = v_now
  where organization_id = p_organization_id;

  return v_new;
end;
$$;

revoke execute on function public.rotate_stripe_customer_creation(bigint, text, text) from public, anon, authenticated;
grant execute on function public.rotate_stripe_customer_creation(bigint, text, text) to service_role;

-- Recording the result also ends the operation, so a later request need not
-- wait out the lease.
create or replace function public.record_stripe_customer(
  p_organization_id bigint,
  p_creation_id text,
  p_customer_id text
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
  set stripe_customer_id = p_customer_id,
      customer_creation_lease_owner = null,
      customer_creation_lease_expires_at = null
  where organization_id = p_organization_id
    and customer_creation_id = p_creation_id
    and (stripe_customer_id is null or stripe_customer_id = p_customer_id);

  return found;
end;
$$;

revoke execute on function public.record_stripe_customer(bigint, text, text) from public, anon, authenticated;
grant execute on function public.record_stripe_customer(bigint, text, text) to service_role;
