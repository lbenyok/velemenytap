-- Round 12 independent review, finding R12-01 (P1). Forward migration on top
-- of 20260910160000.
--
-- ===========================================================================
-- THE DEFECT: "no RECORDED Session" was read as "no Session"
-- ===========================================================================
--
-- Two places decide it is safe to discard a checkout attempt -- which frees
-- the idempotency key, so the next attempt mints a new one and Stripe creates
-- a genuinely new Session:
--
--   * migration 20260910150000's retire predicate (no recorded Session
--     pointer, no live operation lease); and
--   * features/billing/actions.ts's rotation branch, when the stored plan no
--     longer matches or the attempt is past the ~23h idempotency-key window.
--
-- Both are sound only if "this row has no recorded Session" implies "Stripe
-- created no Session". It does not. The application calls
-- `checkout.sessions.create()` and records the returned id in two separate
-- steps; a crash, timeout or database failure between them leaves a REAL,
-- open, payable Session at Stripe and no local pointer to it.
--
-- The codebase already said so, in both places, and then relied on the
-- negation anyway:
--
--   * at the record call: "A Session that exists at Stripe but was never
--     written down here is invisible to every later attempt -- which is
--     exactly how a customer ends up with two."
--   * at the rotation branch, correcting an earlier overclaim: "What is
--     actually true is narrower: there is no RECORDED Session to lose here,
--     so discarding the attempt costs nothing THAT THIS APP CAN SEE."
--
-- Not being able to see it is not evidence that it is not there. This is the
-- third instance of one inference in this project: an empty Customer Search
-- read as absence (R9/R10, § I5), an identity's age read as proof it was sent
-- (R10-04, § I4), and now a missing local pointer read as proof nothing was
-- created.
--
-- The timing is not hypothetical. The rotation window is ~23 hours (Stripe's
-- documented minimum idempotency-key retention), while a Checkout Session's
-- default lifetime is 24 hours FROM THE SESSION'S OWN CREATION. A Session
-- created late in an attempt's life is still open when that attempt is
-- rotated -- the two clocks were never the same clock.
--
-- ===========================================================================
-- THE FIX: the same explicit state this project already uses for customers
-- ===========================================================================
--
-- § I4 solved precisely this question for Stripe Customers: an idempotency key
-- is a replay only if it was ACTUALLY SENT, so "was it sent?" is recorded as a
-- durable fact instead of inferred. Checkout attempts get the same treatment.
--
--   unused  minted by this app, never sent to Stripe. No Session can exist
--           under it, so discarding it genuinely costs nothing.
--   sent    a create() was issued under this attempt's idempotency key. It may
--           have produced a Session whether or not one was recorded, so the
--           attempt may NOT be discarded on local state alone.
--
-- The application moves `unused -> sent` immediately BEFORE the Stripe call,
-- so a crash during the call still records that it may have landed. Where an
-- attempt is `sent` with no recorded Session, the coordinator resolves the
-- uncertainty against Stripe -- by enumerating the customer's Sessions for an
-- open one -- instead of assuming. A completed enumeration finding none is a
-- sound negative; anything else leaves the attempt pending (§ I5).
--
-- Reconciliation is simply barred from retiring a `sent` attempt. It never
-- talks to Stripe about Sessions, so it can never hold the evidence that would
-- justify it (§ R11-01's ownership point, applied one level deeper).

alter table public.organization_billing
  add column checkout_request_state text not null default 'unused'
    check (checkout_request_state in ('unused', 'sent'));

comment on column public.organization_billing.checkout_request_state is
  'Whether a checkout.sessions.create() was ever issued under the current '
  'checkout_attempt_id. unused = never sent, so no Session can exist under it '
  'and the attempt may be discarded freely. sent = may have produced a Session '
  'at Stripe whether or not one was recorded locally, so it may only be '
  'discarded once Stripe itself has been asked. R12-01 existed because a '
  'missing local Session pointer was read as proof no Session existed.';

-- ---------------------------------------------------------------------------
-- The fence taken immediately before the external call.
-- ---------------------------------------------------------------------------
--
-- Mirrors mark_stripe_customer_key_sent. Requires the caller to still hold the
-- attempt and its operation lease, so a superseded worker cannot mark an
-- attempt it no longer owns.

create function public.mark_checkout_request_sent(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set checkout_request_state = 'sent'
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
    and checkout_attempt_expires_at > clock_timestamp()
  returning true;
$$;

revoke execute on function public.mark_checkout_request_sent(bigint, text, text) from public, anon, authenticated;
grant execute on function public.mark_checkout_request_sent(bigint, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The claim reports the state, and minting a fresh attempt resets it.
-- ---------------------------------------------------------------------------
--
-- Return type changes, so this must be dropped and re-created. That operation
-- is what silently lost three guarantees in migration 40, so this body is a
-- verbatim copy of 20260908100000's with exactly two additions -- the
-- `checkout_request_state` output column, and the reset to 'unused' in the
-- mint branch -- and the result is diffed against the original as part of this
-- round's verification rather than trusted by inspection.

drop function if exists public.claim_checkout_attempt(bigint, text, text, jsonb, int);

create function public.claim_checkout_attempt(
  p_organization_id bigint,
  p_interval text,
  p_price_id text,
  p_request jsonb,
  p_claim_seconds int default 150
)
returns table (
  attempt_id text,
  owner_token text,
  is_new_attempt boolean,
  existing_session_id text,
  existing_interval text,
  existing_price_id text,
  existing_mode text,
  request jsonb,
  retry_safe boolean,
  request_state text,
  attempt_created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_owner text;
  v_is_new boolean := false;
  v_prev_session text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- clock_timestamp() is read AFTER the row lock is granted, never before
  -- waiting for it.
  v_now := clock_timestamp();

  if p_interval is null or p_interval not in ('monthly', 'yearly')
     or coalesce(p_price_id, '') = ''
     or v_row.stripe_customer_id is null
     or p_request is null
     or p_request ->> 'mode' is distinct from 'subscription'
     or p_request ->> 'customer' is distinct from v_row.stripe_customer_id
     or p_request #>> '{line_items,0,price}' is distinct from p_price_id
     or p_request ->> 'client_reference_id' is distinct from p_organization_id::text
  then
    raise exception 'Invalid checkout request for organization %', p_organization_id using errcode = 'VT302';
  end if;

  if v_row.checkout_owner_token is not null
     and v_row.checkout_attempt_expires_at is not null
     and v_row.checkout_attempt_expires_at > v_now
  then
    return query select
      v_row.checkout_attempt_id, null::text, false,
      v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
      v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode,
      v_row.checkout_request, false, v_row.checkout_request_state, v_row.checkout_created_at;
    return;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  v_prev_session := v_row.pending_checkout_session_id;

  -- A legacy attempt from before 20260908100000 has no stored request and
  -- therefore nothing safe to replay: its identity is discarded and a new
  -- attempt minted. That Session id is still RETURNED (v_prev_session) so the
  -- caller reconciles it against Stripe before creating anything new.
  if v_row.checkout_attempt_id is null or v_row.checkout_request is null then
    update public.organization_billing
    set checkout_attempt_id = encode(extensions.gen_random_bytes(16), 'hex'),
        checkout_attempt_interval = p_interval,
        checkout_attempt_price_id = p_price_id,
        checkout_attempt_mode = 'subscription',
        checkout_request = p_request,
        checkout_created_at = v_now,
        pending_checkout_session_id = null,
        -- R12-01: a freshly minted identity has never been sent to Stripe.
        checkout_request_state = 'unused'
    where organization_id = p_organization_id;
    v_is_new := true;
  end if;

  update public.organization_billing
  set checkout_owner_token = v_owner,
      checkout_attempt_expires_at = v_now + make_interval(secs => greatest(1, least(600, p_claim_seconds)))
  where organization_id = p_organization_id
  returning * into v_row;

  return query select
    v_row.checkout_attempt_id, v_owner, v_is_new,
    v_prev_session, v_row.checkout_attempt_interval,
    v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode,
    v_row.checkout_request,
    coalesce(v_row.checkout_created_at > v_now - interval '23 hours', false),
    v_row.checkout_request_state, v_row.checkout_created_at;
end;
$$;

revoke execute on function public.claim_checkout_attempt(bigint, text, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(bigint, text, text, jsonb, int) to service_role;

-- ---------------------------------------------------------------------------
-- Releasing an attempt resets the state with it.
-- ---------------------------------------------------------------------------
--
-- release_checkout_attempt destroys the identity, so the state describing that
-- identity must go with it -- otherwise the NEXT attempt inherits a stale
-- `sent` and is treated as possibly having produced a Session it never could.

create or replace function public.release_checkout_attempt(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set checkout_attempt_id = null,
      checkout_attempt_interval = null,
      checkout_attempt_price_id = null,
      checkout_attempt_mode = null,
      checkout_attempt_expires_at = null,
      checkout_owner_token = null,
      checkout_request = null,
      checkout_created_at = null,
      pending_checkout_session_id = null,
      checkout_request_state = 'unused'
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
  returning true;
$$;

revoke execute on function public.release_checkout_attempt(bigint, text, text) from public, anon, authenticated;
grant execute on function public.release_checkout_attempt(bigint, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Reconciliation may not retire an attempt that was sent to Stripe.
-- ---------------------------------------------------------------------------

create or replace function public.write_reconciliation_result(
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
  v_retire_checkout boolean;
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

  v_subs_completed := greatest(v_row.billing_sync_completed, p_requested_generation);
  v_dirty := v_row.billing_sync_requested > v_subs_completed
             or (v_row.activated_at is null and v_row.activation_requested > v_row.activation_completed);

  -- R11-01 kept a recorded Session and a live operation lease safe. R12-01
  -- adds the case neither covered: an attempt whose create() was ISSUED and
  -- whose Session was never written down. This writer never talks to Stripe
  -- about Sessions, so it can never hold the evidence that would justify
  -- discarding one -- only the checkout coordinator can, and it does.
  v_retire_checkout :=
        v_row.pending_checkout_session_id is null
    and v_row.checkout_request_state = 'unused'
    and (v_row.checkout_attempt_expires_at is null or v_row.checkout_attempt_expires_at <= v_now);

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
      checkout_attempt_id = case when v_retire_checkout then null else checkout_attempt_id end,
      checkout_attempt_interval = case when v_retire_checkout then null else checkout_attempt_interval end,
      checkout_attempt_price_id = case when v_retire_checkout then null else checkout_attempt_price_id end,
      checkout_attempt_mode = case when v_retire_checkout then null else checkout_attempt_mode end,
      checkout_attempt_expires_at = case when v_retire_checkout then null else checkout_attempt_expires_at end,
      checkout_owner_token = case when v_retire_checkout then null else checkout_owner_token end,
      checkout_request = case when v_retire_checkout then null else checkout_request end,
      checkout_created_at = case when v_retire_checkout then null else checkout_created_at end,
      pending_checkout_session_id = case when v_retire_checkout then null else pending_checkout_session_id end
  where organization_id = p_organization_id;

  return true;
end;
$$;

revoke execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.write_reconciliation_result(bigint, text, bigint, text, text, text, timestamptz, boolean) to service_role;
