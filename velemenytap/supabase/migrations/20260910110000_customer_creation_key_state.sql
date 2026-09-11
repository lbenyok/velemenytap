-- Round 10 independent review, findings R10-04 (P2) and R10-05 (P2). A forward
-- migration on top of 20260909120000; nothing already applied is edited.
--
-- THE DEFECT (R10-04). 20260909120000 stamped `legacy-org-<id>` on EVERY row
-- with no stripe_customer_id, on the reasoning that an unresolved row must
-- have come from the previous billing version and its deterministic
-- `customer-create:org-<id>` key. "Unresolved" does not imply that. A
-- deployment that has run 20260908120000 can already hold a perfectly valid
-- RANDOM creation identity whose Stripe Customer exists but was never recorded
-- locally -- the process died between create() and record. The backfill
-- overwrote that identity, and for a recent organization the replacement is
-- retry-safe, so recovery is skipped and create() replays a DIFFERENT key: a
-- second Customer. The review reproduced exactly that, ending with two
-- Customers under two keys.
--
-- THE DEFECT (R10-05). The creation lease excludes LIVE contenders but cannot
-- fence a worker that resumes after its lease expired. A claimant that pauses
-- between claiming and calling Stripe can wake after a successor has
-- enumerated, rotated and created, and then create again under the retired
-- key. Its record is correctly rejected -- but only after a second Customer
-- already exists at Stripe, and the code then discarded that fact silently.
--
-- WHAT THESE HAVE IN COMMON. Both are the same wrong inference: that a
-- creation identity's AGE tells you whether replaying it is a genuine replay.
-- It does not. An idempotency key deduplicates only a request that was
-- actually sent. A key a migration invented, or one minted and never used,
-- deduplicates nothing -- replaying it creates a second object. Round 9 fixed
-- one instance of this (an invented random key) by inventing a different key,
-- which is the same mistake in reverse.
--
-- THE FIX: make "was this key actually sent to Stripe?" a durable, explicit
-- fact instead of an inference from a timestamp.
--
--   unused             minted by this app, never sent. Nothing can exist under
--                      it, so no recovery is needed and none is performed.
--   sent               sent at least once and may have landed. Replay inside
--                      the retention window; enumerate outside it.
--   unverified_legacy  stamped by a migration. An earlier billing version may
--                      have created a Customer under some other key entirely,
--                      so age proves nothing: ALWAYS enumerate.
--
-- The application moves unused -> sent immediately BEFORE the Stripe call, so
-- a crash during the call still records that it may have landed.
--
-- This preserves valid modern identities (R10-04): this migration overwrites
-- no identity at all, because the identity's VALUE is no longer what decides
-- safety.
--
-- A row whose identity 20260909120000 ALREADY overwrote cannot be restored --
-- that information is gone -- but the guarantee it protected is not, because
-- such a row is `unverified_legacy` and therefore goes through the canonical
-- enumeration. That enumeration matches on `metadata.organization_id`, not on
-- the idempotency key, so it finds the Customer whichever key created it.
-- Verified against this repository's own history: EVERY version of
-- createStripeCustomer, back to the first, has set that metadata. (In practice
-- no such row exists outside the isolated test project: production is on
-- migration 17, so the columns 36/38/39 operate on have never existed there,
-- and no Customer has ever been created against it.)
--
-- See BILLING_INVARIANTS.md § I4/I5.

alter table public.organization_billing
  add column customer_creation_key_state text not null default 'unused'
    check (customer_creation_key_state in ('unused', 'sent', 'unverified_legacy'));

comment on column public.organization_billing.customer_creation_key_state is
  'Whether customer_creation_id was ever actually sent to Stripe, which is the '
  'only thing that makes replaying it a real idempotent replay. unused = never '
  'sent (safe to create directly); sent = may have landed (replay inside '
  'retention, else enumerate); unverified_legacy = stamped by a migration, a '
  'previous billing version may have created a Customer under a different key '
  '(always enumerate). R10-04 existed because this was inferred from age.';

-- Every identity that exists TODAY predates the app ever recording that it was
-- sent, so none of them may be trusted as a replay. Unresolved rows are marked
-- unverified_legacy and will go through the canonical enumeration, which is
-- sound whatever key their Customer was really created under -- including the
-- valid modern identities 20260909120000 overwrote.
update public.organization_billing
set customer_creation_key_state = 'unverified_legacy'
where stripe_customer_id is null
  and customer_creation_id is not null;

-- ---------------------------------------------------------------------------
-- Claim: retry-safety now requires the key to have been sent.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_stripe_customer_creation(bigint, int);

create function public.claim_stripe_customer_creation(
  p_organization_id bigint,
  p_lease_seconds int default 150
)
returns table (
  customer_id text,
  creation_id text,
  started_at timestamptz,
  retry_safe boolean,
  needs_recovery boolean,
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
    return query select v_row.stripe_customer_id, null::text, null::timestamptz, false, false, null::text;
    return;
  end if;

  -- R9-03: another creation is in flight. Stand down rather than racing it --
  -- a fresh enumeration cannot prove that an in-flight create() will not land
  -- a moment later.
  if v_row.customer_creation_lease_owner is not null
     and v_row.customer_creation_lease_expires_at is not null
     and v_row.customer_creation_lease_expires_at > v_now
  then
    return query select
      null::text, v_row.customer_creation_id, v_row.customer_creation_started_at, false, false, null::text;
    return;
  end if;

  if v_row.customer_creation_id is null then
    update public.organization_billing
    set customer_creation_id = encode(extensions.gen_random_bytes(16), 'hex'),
        customer_creation_started_at = v_now,
        customer_creation_key_state = 'unused'
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
    -- R10-04: a replay is genuine only if the key was actually SENT. Age alone
    -- no longer authorizes it.
    v_row.customer_creation_key_state = 'sent'
      and coalesce(v_row.customer_creation_started_at > v_now - interval '23 hours', false),
    -- Anything other than a key this app minted and never used may already
    -- have produced a Customer somewhere, so it must be recovered, not
    -- assumed absent.
    v_row.customer_creation_key_state <> 'unused',
    v_owner;
end;
$$;

revoke execute on function public.claim_stripe_customer_creation(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_stripe_customer_creation(bigint, int) to service_role;

-- ---------------------------------------------------------------------------
-- The fence immediately before the external call (R10-05).
-- ---------------------------------------------------------------------------
--
-- Called by the application in the same breath as create(), and doing two
-- things at once deliberately:
--
--   1. It records that this key is about to be sent, so a crash mid-call
--      cannot leave the row claiming the key was never used. This is what
--      makes `sent` trustworthy at all.
--   2. It re-checks the lease AFTER the caller has done everything else, and
--      requires enough of it to remain to cover the Stripe call's own bounded
--      lifetime (lib/stripe.ts: 20s timeout, 2 retries). A worker whose lease
--      already expired, or is about to, is refused here and never reaches
--      Stripe.
--
-- HONEST LIMIT, because the previous version of this comment claimed more than
-- the code does: this narrows R10-05's window to the gap between this check
-- and Stripe receiving the request. It does NOT close it. No database lease
-- can revoke a request that is already in flight at Stripe, and a process can
-- be paused arbitrarily long at any point. The residual case is handled by
-- DETECTING the orphan rather than pretending it cannot happen -- see
-- record_stripe_customer's caller, which records an `orphaned_customer`
-- anomaly when its create() result is rejected. See OPERATOR_RECOVERY.md.

create function public.mark_stripe_customer_key_sent(
  p_organization_id bigint,
  p_creation_id text,
  p_owner_token text,
  p_required_seconds int default 60
)
returns boolean
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
    return false;
  end if;
  v_now := clock_timestamp();

  if v_row.stripe_customer_id is not null then
    return false;
  end if;
  if v_row.customer_creation_id is distinct from p_creation_id then
    return false;
  end if;
  if v_row.customer_creation_lease_owner is distinct from p_owner_token
     or v_row.customer_creation_lease_expires_at is null
     or v_row.customer_creation_lease_expires_at <= v_now + make_interval(secs => greatest(0, p_required_seconds))
  then
    return false;
  end if;

  update public.organization_billing
  set customer_creation_key_state = 'sent'
  where organization_id = p_organization_id;

  return true;
end;
$$;

revoke execute on function public.mark_stripe_customer_key_sent(bigint, text, text, int) from public, anon, authenticated;
grant execute on function public.mark_stripe_customer_key_sent(bigint, text, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- Rotation: a retired key's replacement starts unused.
-- ---------------------------------------------------------------------------

drop function if exists public.rotate_stripe_customer_creation(bigint, text, text);

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
  -- Refused while a genuine replay is still possible: retiring a key that
  -- Stripe would still deduplicate throws away the protection. A key that was
  -- never sent has no such protection to throw away, so its age is irrelevant.
  if v_row.customer_creation_key_state = 'sent'
     and coalesce(v_row.customer_creation_started_at > v_now - interval '23 hours', false)
  then
    return null;
  end if;

  v_new := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set customer_creation_id = v_new,
      customer_creation_started_at = v_now,
      customer_creation_key_state = 'unused'
  where organization_id = p_organization_id;

  return v_new;
end;
$$;

revoke execute on function public.rotate_stripe_customer_creation(bigint, text, text) from public, anon, authenticated;
grant execute on function public.rotate_stripe_customer_creation(bigint, text, text) to service_role;
