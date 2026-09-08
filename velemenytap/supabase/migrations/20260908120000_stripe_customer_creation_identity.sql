-- Fifth round, part three (2026-09-08). A forward migration on top of
-- 20260908110000, correcting a claim made by 20260908100000's own
-- integration round rather than a defect that round introduced.
--
-- THE CLAIM THAT WAS WRONG. When integrating the parallel implementation,
-- its `claim_stripe_customer`/`record_stripe_customer` pair was explicitly
-- rejected on the grounds that this repo's Stripe metadata search is
-- "authoritative even after an idempotency key has expired, which is
-- precisely the case the frozen-key approach cannot cover" and therefore
-- "strictly stronger." Checking that against Stripe's own published
-- documentation for the Customer Search API shows it is not:
--
--   "Don't use search in read-after-write flows where strict consistency
--    is necessary. Under normal operating conditions, data is searchable
--    in less than a minute. Occasionally, propagation of new or updated
--    data can be up to an hour behind during outages."
--    -- docs.stripe.com/api/customers/search
--
-- And, on the other side, idempotency keys are explicitly not permanent:
--
--   "You can remove keys from the system automatically after they're at
--    least 24 hours old. We generate a new request if a key is reused
--    after the original is pruned."
--    -- docs.stripe.com/api/idempotent_requests
--
-- So neither mechanism is sufficient alone, and the previous code used
-- the search in exactly the read-after-write flow Stripe warns against.
--
-- THE CONCRETE DUPLICATE. getOrCreateStripeCustomerId called
-- customers.create() with a key derived only from the organization id,
-- and reached that call whenever the recovery search returned no
-- results -- including when the search had FAILED, which it treated
-- identically to a negative result ("proceeding to create"). Therefore:
--
--   1. T=0    a create() succeeds at Stripe; the response is lost, or the
--             database write that would record it fails. Nothing local
--             records that cus_X exists.
--   2. T=25h  the owner retries. The search fails (a Stripe incident, a
--             timeout, a rate limit) -- or, far less likely but equally
--             fatal, is still lagging.
--   3.        the code treats "no result" as "nothing exists" and calls
--             create() again. The key was pruned at 24h, so Stripe
--             "generate[s] a new request": cus_Y is created.
--
-- The organization now has two Stripe Customers while reconciliation only
-- ever lists subscriptions for the one persisted locally. A customer who
-- then pays on the other one is charged and stays locked out of the
-- dashboard -- the worst failure this product has.
--
-- THE FIX, and why the two mechanisms are complementary rather than
-- redundant. The frozen key is authoritative from 0 to ~24 hours, exactly
-- where search may lag. Search is authoritative from ~1 hour onward,
-- exactly where the key may be pruned. Their overlap is what makes the
-- whole timeline safe -- but only if the application knows WHEN the
-- creation was attempted, which requires a durable local record. That is
-- what these two columns are:
--
--   * inside the retry-safe window, replay create() under the frozen key
--     and do not search at all -- removing the read-after-write use of
--     search entirely, rather than merely making it more careful;
--   * outside it, the search must SUCCEED. A failed search is no
--     information, and the caller now fails closed instead of creating.
--     An empty result is trusted only because the recorded attempt is by
--     then older than both the key lifetime and Stripe's documented
--     worst-case propagation delay, with ~22 hours of margin.
--
-- This restores the parallel implementation's mechanism, on the merits.
alter table public.organization_billing
  add column customer_creation_id text,
  add column customer_creation_started_at timestamptz;

-- Any organization that has a checkout attempt on file but no customer
-- recorded is precisely the state an interrupted creation leaves behind.
-- Stamping the attempt's own creation time (rather than now()) keeps the
-- retry-safety window honest: a genuinely old interrupted creation must
-- NOT be reported as freshly retry-safe just because this migration ran.
update public.organization_billing
set customer_creation_id = encode(extensions.gen_random_bytes(16), 'hex'),
    customer_creation_started_at = coalesce(checkout_created_at, created_at)
where stripe_customer_id is null
  and checkout_attempt_id is not null;

-- Claims the right to create this organization's Stripe Customer, minting
-- a creation identity once and never rotating it while it stands. Every
-- concurrent caller receives the SAME creation id and therefore the same
-- idempotency key, so Stripe deduplicates them against each other without
-- this application having to serialize the network calls themselves.
--
-- retry_safe is the caller's whole decision procedure: true means "the
-- frozen key is still live at Stripe, so replaying create() cannot produce
-- a second Customer"; false means "the key may be pruned -- you must
-- establish by other means that no Customer exists before creating one."
-- 23 hours, not 24, because Stripe's stated retention is a floor ("at
-- least 24 hours"), not a promise, and the margin costs nothing.
create function public.claim_stripe_customer_creation(p_organization_id bigint)
returns table (
  customer_id text,
  creation_id text,
  started_at timestamptz,
  retry_safe boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- Read the clock after the lock is granted, never before waiting for it.
  v_now := clock_timestamp();

  -- Already resolved: nothing to claim, and no creation identity is minted
  -- (a later caller must never be handed one for an organization that
  -- already has a Customer).
  if v_row.stripe_customer_id is not null then
    return query select v_row.stripe_customer_id, null::text, null::timestamptz, false;
    return;
  end if;

  if v_row.customer_creation_id is null then
    update public.organization_billing
    set customer_creation_id = encode(extensions.gen_random_bytes(16), 'hex'),
        customer_creation_started_at = v_now
    where organization_id = p_organization_id
    returning * into v_row;
  end if;

  return query select
    null::text,
    v_row.customer_creation_id,
    v_row.customer_creation_started_at,
    coalesce(v_row.customer_creation_started_at > v_now - interval '23 hours', false);
end;
$$;

revoke execute on function public.claim_stripe_customer_creation(bigint) from public, anon, authenticated;
grant execute on function public.claim_stripe_customer_creation(bigint) to service_role;

-- Records the Customer a creation attempt produced, CAS'd on that exact
-- creation identity. A caller holding a superseded identity (its attempt
-- having been retired by rotate_stripe_customer_creation below) matches
-- zero rows and must not overwrite the newer one. Idempotent for the same
-- customer id, so concurrent callers deduplicated by Stripe both succeed.
create function public.record_stripe_customer(
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
  set stripe_customer_id = p_customer_id
  where organization_id = p_organization_id
    and customer_creation_id = p_creation_id
    and (stripe_customer_id is null or stripe_customer_id = p_customer_id);

  return found;
end;
$$;

revoke execute on function public.record_stripe_customer(bigint, text, text) from public, anon, authenticated;
grant execute on function public.record_stripe_customer(bigint, text, text) to service_role;

-- Retires a creation identity whose idempotency key is dead, and mints a
-- replacement. Called ONLY after a SUCCESSFUL search has confirmed that no
-- Customer carrying this organization's id exists at Stripe -- never after
-- a failed one, and never inside the retry-safe window, where the old key
-- is still the thing protecting against duplicates.
--
-- p_creation_id is required so this cannot retire an identity the caller
-- does not hold, and the retry-safe window is re-checked HERE, under the
-- row lock, rather than trusted from the caller: a claim that was outside
-- the window when the caller read it cannot have moved back inside it, but
-- a concurrent caller could have rotated it already, and that rotation
-- must win.
create function public.rotate_stripe_customer_creation(
  p_organization_id bigint,
  p_creation_id text
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

revoke execute on function public.rotate_stripe_customer_creation(bigint, text) from public, anon, authenticated;
grant execute on function public.rotate_stripe_customer_creation(bigint, text) to service_role;
