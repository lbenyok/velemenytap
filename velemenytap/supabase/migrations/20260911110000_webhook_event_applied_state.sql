-- Round 12 independent review, finding R12-03 (P2). Forward migration.
--
-- THE DEFECT. The webhook route applies an event's effects FIRST and inserts
-- its id into the ledger afterwards. A unique violation on that insert is
-- reported as `duplicate: true` -- but the effects have already run by then,
-- so the ledger records duplicates without preventing them.
--
-- Round 9's `apply-then-record` choice was deliberate and is still right as a
-- RETRY policy: recording first and then failing would lose the work entirely,
-- because the next delivery would see the id and skip. What was missing is
-- that the effects are not all idempotent. `request_billing_activation`
-- correctly keeps the FIRST payment evidence -- but it increments
-- activation_requested, activation_completed and (since R11-02)
-- billing_sync_requested on every delivery. A duplicate arriving after the
-- first reconciliation has completed therefore schedules another full
-- subscription-history scan for no reason. The generation counters stay
-- correct and no second activation or charge occurs; this is wasted work and
-- delayed convergence, not a money defect.
--
-- The focused duplicate-delivery test asserted only the final HTTP body, so it
-- would have passed even if every effect had run twice.
--
-- THE FIX: the recoverable started/applied distinction the review asked for.
--
--   * A row with `applied_at` NULL means "some delivery claimed this event and
--     has not finished". Re-applying is correct -- the previous attempt may
--     have died before doing anything.
--   * A row with `applied_at` SET means "the effects completed". A later
--     delivery is a true duplicate and does nothing at all.
--
-- So the retry guarantee is kept exactly (a failed apply leaves applied_at
-- null, Stripe redelivers, and the next delivery re-applies), while a
-- duplicate of an event that already SUCCEEDED becomes a genuine no-op.
--
-- Existing rows are backfilled to applied_at = created_at: every row that
-- exists was written by the old code, which only ever inserted AFTER a
-- successful apply. Treating them as applied is exactly what they are.

alter table public.stripe_webhook_events
  add column applied_at timestamptz;

update public.stripe_webhook_events
set applied_at = created_at
where applied_at is null;

comment on column public.stripe_webhook_events.applied_at is
  'When this event''s effects finished. NULL means a delivery claimed the event '
  'and did not complete, so a later delivery must re-apply it; set means the '
  'effects are done and a later delivery is a true duplicate that must do '
  'nothing. R12-03 existed because the ledger recorded duplicates without '
  'preventing their effects.';

-- Claims an event for processing, or reports that it is already done.
--
-- Returns true when the caller should APPLY the event (either it is new, or a
-- previous delivery claimed it and never finished), false when the event has
-- already been applied and must not run again.
create function public.claim_stripe_webhook_event(p_event_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_applied_at timestamptz;
begin
  insert into public.stripe_webhook_events (id)
  values (p_event_id)
  on conflict (id) do nothing;

  if found then
    return true;
  end if;

  select applied_at into v_applied_at
  from public.stripe_webhook_events
  where id = p_event_id;

  -- Claimed by an earlier delivery that never finished: re-apply. The effects
  -- this route performs are safe to repeat (the activation latch is
  -- first-evidence-wins, reconciliation is idempotent by construction); what
  -- is NOT safe is repeating them after a successful apply, which is the case
  -- below.
  return v_applied_at is null;
end;
$$;

revoke execute on function public.claim_stripe_webhook_event(text) from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_event(text) to service_role;

-- Marks the claimed event's effects as complete. Idempotent; only ever moves
-- null -> a value, so a redelivery racing the original cannot re-date it.
create function public.mark_stripe_webhook_event_applied(p_event_id text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.stripe_webhook_events
  set applied_at = coalesce(applied_at, clock_timestamp())
  where id = p_event_id
  returning true;
$$;

revoke execute on function public.mark_stripe_webhook_event_applied(text) from public, anon, authenticated;
grant execute on function public.mark_stripe_webhook_event_applied(text) to service_role;
