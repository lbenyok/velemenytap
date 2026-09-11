-- Round 9 independent review, finding R9-05 (P2). Forward migration; the two
-- older definitions are already in migration history and are corrected here
-- rather than edited.
--
-- This project has now hit "evaluate a time-based condition against an instant
-- captured before the last lock wait" five times (R6-04, R7-05, R7-05's own
-- postscript, the round-8 billing lease, and this). Each previous round
-- searched for the class and each previous search missed the next instance.
-- The reason is visible in the two cases below: neither looks wrong at the
-- statement that is actually wrong.
--
--   * confirm_notification_email_change compares against `now()`, which is
--     TRANSACTION-START time. The review held the organization row lock,
--     started a confirmation while the token was still valid, waited for the
--     token to expire, then released the lock -- and the function accepted the
--     expired token and promoted the pending address. The bug is not that the
--     comparison is missing; it is that the instant it compares to predates
--     the wait.
--
--   * claim_negative_alert_send does use clock_timestamp(), captured
--     immediately after its ADVISORY lock, which is what the previous round
--     fixed. But the card ROW lock is taken later, by the UPDATE itself. The
--     review held that row lock and observed a reservation recorded 1,521 ms
--     before the lock was released -- a backdated last_negative_alert_at, so
--     the effective cooldown is shortened by however long the wait was.
--
-- The generalisable rule, stated here because searching for the shape has
-- repeatedly failed: acquire EVERY lock the decision depends on first, then
-- read the clock, then decide. A lock taken implicitly by the deciding
-- statement is still a lock, and it is the easiest one to miss.

-- Lock the candidate row explicitly, then judge its expiry against a clock
-- read afterwards. Matching stays on the token hash and the whole check
-- remains atomic: the UPDATE re-applies every condition, so a row that was
-- confirmed or re-requested while this call waited still matches zero rows.
create or replace function public.confirm_notification_email_change(p_token text)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_candidate bigint;
  v_now timestamptz;
  v_token_hash text := encode(extensions.digest(p_token, 'sha256'), 'hex');
begin
  -- Take the row lock BEFORE reading the clock. Without this the expiry below
  -- is judged against transaction-start time, which can be arbitrarily far in
  -- the past by the time a contended row is finally available.
  select id into v_candidate
  from public.organizations
  where notification_email_pending_token_hash = v_token_hash
  for update;

  if v_candidate is null then
    return null;
  end if;

  v_now := clock_timestamp();

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email = notification_email_pending,
      notification_email_pending = null,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where id = v_candidate
    and notification_email_pending_token_hash = v_token_hash
    and notification_email_pending_expires_at > v_now
    and notification_email_pending is not null
  returning id into v_org_id;

  return v_org_id;
end;
$$;

revoke execute on function public.confirm_notification_email_change(text) from public, anon, authenticated;
grant execute on function public.confirm_notification_email_change(text) to service_role;

-- Same correction, one lock further down: the advisory lock serialises claims
-- for an organization, but the card row lock is what the cooldown decision and
-- the written timestamp actually depend on, and the UPDATE was taking it after
-- the clock had already been read.
create or replace function public.claim_negative_alert_send(
  p_nfc_card_id bigint,
  p_cooldown_minutes int default 5,
  p_org_hourly_budget int default 30
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_recent_org_count integer;
  v_claimed_id bigint;
  v_log_id bigint;
  v_now timestamptz;
begin
  select organization_id into v_org_id from public.nfc_cards where id = p_nfc_card_id;
  if v_org_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('claim_negative_alert_send:' || v_org_id::text)::bigint);

  -- The card row lock, taken EXPLICITLY and before the clock read. The UPDATE
  -- below would otherwise acquire it itself, after v_now had been fixed --
  -- backdating both the cooldown comparison and last_negative_alert_at by
  -- however long the wait lasted.
  perform 1 from public.nfc_cards where id = p_nfc_card_id for update;

  -- Every lock this decision depends on is now held, so this instant is the
  -- one the decision is actually made at.
  v_now := clock_timestamp();

  select count(*) into v_recent_org_count
  from private.alert_email_log
  where organization_id = v_org_id
    and status <> 'failed'
    and reserved_at > v_now - interval '1 hour';

  if v_recent_org_count >= p_org_hourly_budget then
    return null;
  end if;

  perform set_config('app.allow_cooldown_update', 'true', true);
  update public.nfc_cards
  set last_negative_alert_at = v_now
  where id = p_nfc_card_id
    and (
      last_negative_alert_at is null
      or last_negative_alert_at < v_now - (p_cooldown_minutes || ' minutes')::interval
    )
  returning id into v_claimed_id;

  if v_claimed_id is null then
    return null;
  end if;

  insert into private.alert_email_log (organization_id, nfc_card_id, status, reserved_at)
  values (v_org_id, p_nfc_card_id, 'reserved', v_now)
  returning id into v_log_id;

  return v_log_id;
end;
$$;

revoke execute on function public.claim_negative_alert_send(bigint, int, int) from public, anon, authenticated;
grant execute on function public.claim_negative_alert_send(bigint, int, int) to service_role;
