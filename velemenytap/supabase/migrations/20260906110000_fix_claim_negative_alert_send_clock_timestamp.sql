-- Round-7 finding R7-05 (MEDIUM). claim_negative_alert_send() -- already
-- applied to production (migration 20260904135437) -- is a corrective
-- migration, not an edit to that file, for the same reason
-- 20260906090000 was: the object it fixes is live.
--
-- The same class of bug round-6 R6-04 fixed in
-- request_notification_email_change (see migration 20260905193325's own
-- comment for the full mechanics) exists here too, in three places, all
-- using now() -- frozen at this transaction's own START -- after
-- acquiring the per-organization advisory lock:
--   1. the trailing-hour budget cutoff (`reserved_at > now() - interval
--      '1 hour'`)
--   2. the per-card cooldown check (`last_negative_alert_at < now() -
--      (p_cooldown_minutes || ' minutes')::interval`)
--   3. the new cooldown timestamp being written (`last_negative_alert_at
--      = now()`)
-- Under genuine concurrency serialized through the advisory lock, a
-- transaction queued behind others can resume (once the lock is free)
-- with real wall-clock time having advanced well past its own frozen
-- now() -- so its cooldown/budget checks, and the timestamp it writes,
-- all reflect a stale instant rather than the moment it actually runs.
-- With a short enough cooldown/budget window (or just enough queued
-- contention), this can let a request through that should have been
-- rejected, or reject one that should have passed, or write a
-- last_negative_alert_at that doesn't reflect when the claim actually
-- happened.
--
-- Fixed the same way as the notification-email-change budget: one
-- clock_timestamp() value captured immediately after the advisory lock is
-- acquired, reused consistently for every freshness/window decision and
-- for the timestamp written, instead of calling now() (or
-- clock_timestamp()) separately at each point.
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

  -- Captured once, immediately after the lock is acquired -- see this
  -- migration's own header comment for why now() is wrong here.
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
