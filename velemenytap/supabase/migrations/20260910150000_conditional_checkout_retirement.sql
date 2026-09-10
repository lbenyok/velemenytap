-- Round 11 independent review, findings R11-01 (P1) and R11-02 (P2). Forward
-- migration on top of 20260910140000. Both functions keep their signatures, so
-- this is `create or replace` -- nothing is dropped and re-created, which is
-- the operation that silently lost three guarantees in migration 40.
--
-- ===========================================================================
-- R11-01 (P1) -- A SUBSCRIPTION REFRESH FORGOT AN UNRELATED OPEN CHECKOUT
-- ===========================================================================
--
-- Migration 20260908100000 built the whole checkout-attempt design around one
-- sentence, in its own comment:
--
--     "losing the pointer to a real, possibly-completed Session is the one
--      outcome this whole design exists to prevent."
--
-- and release_checkout_attempt's comment claims:
--
--     "This is the ONLY function that destroys the idempotency-key identity"
--
-- Both were false, because write_reconciliation_result cleared
-- checkout_attempt_id, the stored request, the ownership fields AND
-- pending_checkout_session_id on EVERY successful subscription refresh --
-- unconditionally, without inspecting that Session, proving it terminal, or
-- relating it to the subscription being written.
--
-- The round-10 fix (R10-02) hardened reconcileExistingSession so a Session
-- with an unresolved payment can never authorize a replacement. That guard is
-- correct and is retained. It is also irrelevant to a Session that a
-- different writer has already forgotten: the guard only runs on a Session the
-- claim still points at.
--
-- The reproduced ordinary flow, with no failure or race required:
--
--   1. An organization with an older canceled subscription starts resubscribing.
--      Checkout creates Session A, records it, returns its payable URL.
--   2. While A is still open, a scheduled staleness sweep, a delayed webhook or
--      an admin refresh reconciles the OLD canceled subscription.
--   3. That write persists `canceled` and clears the unrelated open attempt.
--   4. The owner clicks subscribe again. hasLiveSubscription allows it (status
--      is canceled) and the attempt claim finds no recorded Session, so
--      Session B is created without A ever being retrieved or expired.
--
-- Two payable Sessions, from ordinary product behaviour.
--
-- I audited this file's re-created functions after migration 40 by comparing
-- assigned columns and found "no unintended loss" -- which was true and
-- useless here, because this cleanup was faithfully PRESERVED. A column-level
-- diff cannot see a requirement about which rows a write is entitled to touch.
--
-- THE FIX. Retire a checkout attempt only when there is demonstrably nothing
-- to lose, judged from state this function can actually see:
--
--   * `pending_checkout_session_id is null` -- no Session pointer exists, so
--     none can be dropped. A recorded Session is left for the checkout
--     coordinator, which is the only component that retrieves Sessions from
--     Stripe and is therefore the only one entitled to decide one is finished.
--
--   * AND no live operation lease -- `checkout_attempt_expires_at` is null or
--     past. This covers the case the review specifically asked about: an
--     attempt claimed AFTER this reconciliation took its lease, whose Session
--     has not been recorded yet. A live lease means a checkout is mid-flight;
--     its Stripe call may already have created a Session that simply is not
--     written down yet.
--
-- What is still retired: an abandoned claim that never produced a Session and
-- whose operation lease has expired. That is genuine housekeeping and loses
-- nothing.
--
-- ===========================================================================
-- R11-02 (P2) -- ACTIVATION ASKED FOR A REFRESH WITHOUT REGISTERING IT
-- ===========================================================================
--
-- Round 10 made activation atomic and had it raise needs_reconciliation, on
-- the reasoning that a payment usually means the subscription status changed
-- too and that refresh is a separate obligation. Correct -- but it registered
-- that obligation with the FLAG only, never advancing billing_sync_requested,
-- and the invoice handler registers it nowhere else.
--
-- The generation counter is what makes an obligation survive a concurrent
-- writer; the flag alone does not. Reproduced against real SQL:
--
--   1. A reconciler holds the lease and has already read `past_due` from
--      Stripe, just before the payment succeeds.
--   2. invoice.paid arrives. Activation writes the latch and evidence and sets
--      needs_reconciliation = true. billing_sync_requested is unchanged.
--   3. The reconciler writes its stale `past_due` observation. Its requested
--      generation still matches, and the activation counters are equal, so its
--      dirty predicate is false -- it clears the flag.
--
-- Result: dirty=false, status=past_due, for an organization that has just
-- paid. Not permanent -- another webhook, a manual refresh or the hourly
-- staleness scan repairs it -- but the payment-triggered refresh is silently
-- discarded, and the row is invisible to both the immediate candidate query
-- and the backlog until the staleness window elapses.
--
-- THE FIX. Register the refresh the way every other caller registers work: by
-- advancing the generation in the same atomic statement that records the
-- payment. A stale writer's older generation then cannot discharge it.

-- ---------------------------------------------------------------------------
-- R11-02: activation registers its status-refresh obligation properly.
-- ---------------------------------------------------------------------------

create or replace function public.request_billing_activation(
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
  -- Evidence is not optional. There is no way to reach activated_at without
  -- producing the payment that justifies it (R10-01).
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

  if v_paid_at > v_now + interval '1 hour' then
    raise exception 'activation evidence paid_at % is in the future', v_paid_at using errcode = 'VT303';
  end if;

  update public.organization_billing
  set activated_at = coalesce(activated_at, v_paid_at),
      activation_evidence = coalesce(activation_evidence, p_evidence),
      activation_requested = activation_requested + 1,
      activation_completed = activation_requested + 1,
      -- R11-02: a payment almost always means the subscription's own status
      -- just changed, and that refresh is a genuinely separate obligation.
      -- Registering it means ADVANCING THE GENERATION, not merely raising the
      -- flag -- a reconciler already holding an older observation can clear a
      -- flag, but it cannot discharge a generation it never saw.
      billing_sync_requested = billing_sync_requested + 1,
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

-- ---------------------------------------------------------------------------
-- R11-01: checkout retirement becomes conditional.
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
  v_subs_completed := greatest(v_row.billing_sync_completed, p_requested_generation);
  v_dirty := v_row.billing_sync_requested > v_subs_completed
             or (v_row.activated_at is null and v_row.activation_requested > v_row.activation_completed);

  -- R11-01: this write is entitled to retire a checkout attempt ONLY when
  -- doing so cannot discard a Session pointer or race a live checkout. See the
  -- header for the two conditions and why each is needed.
  v_retire_checkout :=
        v_row.pending_checkout_session_id is null
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
      -- Unqualified column references on the right-hand side are the OLD
      -- values, so a false predicate leaves every one of these untouched.
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
