-- Round-14 R14-03. The clock-before-lock class, for the SEVENTH time in this
-- project -- and this instance was introduced by round 12's own fix.
--
-- `mark_checkout_request_sent` was a single statement:
--
--     update public.organization_billing
--     set checkout_request_state = 'sent'
--     where organization_id = ...
--       and checkout_attempt_id = ...
--       and checkout_owner_token = ...
--       and checkout_attempt_expires_at > clock_timestamp()
--     returning true;
--
-- The qualification is evaluated during the scan, which happens BEFORE the
-- statement waits for a row lock someone else holds. PostgreSQL re-checks the
-- qualification after the wait only when the tuple was actually updated
-- (EvalPlanQual follows `t_ctid`); a holder that merely took `SELECT ... FOR
-- UPDATE` without writing leaves the tuple version unchanged, so no re-check
-- happens and the pre-wait clock reading stands.
--
-- The reviewer reproduced it against real PostgreSQL: a one-second lease, a
-- plain `SELECT ... FOR UPDATE` holder, the marker confirmed to be waiting on
-- the lock, released after the deadline. The marker returned TRUE and moved
-- the state to `sent` with an already-expired lease.
--
-- Why that matters here specifically: the application treats `true` as
-- authorization to go and create a Checkout Session at Stripe. The lease is
-- what is supposed to guarantee no other worker is about to do the same. So
-- the one check standing between a stale worker and a second payable Session
-- could pass on a lease that had already run out while it waited.
--
-- Fixed by mirroring `mark_stripe_customer_key_sent` (20260910110000), which
-- has had the right shape since round 10: take the row lock, THEN read the
-- clock, then evaluate ownership and expiry against the locked row. It also
-- gains that function's `p_required_seconds` margin -- "not expired yet" is
-- too weak a promise immediately before a remote call that takes time.
--
-- ROUND-15 CORRECTION, so this header does not overstate what shipped: the
-- application's call site does NOT pass that parameter, so its default of 0
-- applies and the effective margin today is ZERO. The lease is still renewed
-- immediately before the Stripe call, which is what actually reserves time;
-- the parameter exists so a caller CAN demand a reserve, not because one is
-- currently demanded. Do not read its presence as added protection.
--
-- The standing limitation is unchanged and still honest: no database lease can
-- fence a process that passed its final check and was then paused before its
-- remote request. That residual is detected rather than prevented (see
-- OPERATOR_RECOVERY.md § 1).

create or replace function public.mark_checkout_request_sent(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text,
  p_required_seconds int default 0
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.organization_billing%rowtype;
  v_now timestamptz;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    return false;
  end if;

  v_now := clock_timestamp();

  if v_row.checkout_attempt_id is distinct from p_attempt_id then
    return false;
  end if;
  if v_row.checkout_owner_token is distinct from p_owner_token then
    return false;
  end if;
  if v_row.checkout_attempt_expires_at is null
     or v_row.checkout_attempt_expires_at <= v_now + make_interval(secs => greatest(0, p_required_seconds))
  then
    return false;
  end if;

  update public.organization_billing
  set checkout_request_state = 'sent'
  where organization_id = p_organization_id;

  return true;
end;
$$;

-- The three-argument signature is what the deployed application calls; the new
-- fourth parameter is defaulted so no caller has to change to stay correct.
-- Both are granted the same way the original was. Neither has ever been
-- deployed (production is on migration 17), so there is no live caller to keep
-- working across this change -- the default exists for readability, not for a
-- rollout window.
revoke execute on function public.mark_checkout_request_sent(bigint, text, text, int) from public, anon, authenticated;
grant execute on function public.mark_checkout_request_sent(bigint, text, text, int) to service_role;

drop function if exists public.mark_checkout_request_sent(bigint, text, text);
