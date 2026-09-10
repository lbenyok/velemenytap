-- Round 11 independent review, raised under target 4 as a scoped qualification
-- rather than a launch blocker: the clock-before-lock class is not literally
-- absent, because `issue_notification_email_change_token` still derives its
-- expiry from `now()` -- transaction-start time -- and its later UPDATE of
-- public.organizations can wait for that row's lock. The review measured a
-- 24-hour token lifetime shortened by 372 ms.
--
-- The impact is small: 372 ms off 24 hours cannot expire a token anyone is
-- actually using, and no expired token is accepted. It is fixed here anyway,
-- for two reasons.
--
-- First, the rule in BILLING_INVARIANTS.md § I6 is stated without an impact
-- threshold -- a time-based decision is taken after every lock it can wait on
-- -- and an exception carved out for "small enough" is exactly how five
-- previous rounds each left the next instance in place.
--
-- Second, and more practically: this is the SIXTH round in which an instance
-- of this class has been found, and every prior class-wide search declared it
-- closed. The honest claim is now narrower and is recorded in
-- BILLING_INVARIANTS.md: every writer whose decision is a cooldown, budget,
-- rate limit, lease or expiry has been audited and fixed, and a future
-- addition can reintroduce the class at any time.
--
-- The same treatment as the others: take the row lock the later UPDATE needs,
-- in the mode it will use, THEN read the clock, then compute from it.

create or replace function public.issue_notification_email_change_token(
  p_log_id bigint,
  p_expires_in_minutes int default 1440
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_raw_token text;
  v_now timestamptz;
begin
  select organization_id into v_org_id
  from private.notification_email_change_log
  where id = p_log_id and status = 'reserved';

  if v_org_id is null then
    raise exception 'unknown or already-resolved notification-email change reservation' using errcode = 'VT205';
  end if;

  -- The row lock the UPDATE below takes anyway, acquired explicitly and first,
  -- so the wait happens BEFORE the instant the expiry is measured from.
  perform 1 from public.organizations where id = v_org_id for no key update;

  v_now := clock_timestamp();

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending_token_hash = encode(extensions.digest(v_raw_token, 'sha256'), 'hex'),
      notification_email_pending_expires_at = v_now + (p_expires_in_minutes || ' minutes')::interval
  where id = v_org_id;

  return v_raw_token;
end;
$$;

revoke execute on function public.issue_notification_email_change_token(bigint, int) from public, anon, authenticated;
grant execute on function public.issue_notification_email_change_token(bigint, int) to service_role;
