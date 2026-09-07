-- Found during this round's own independent adversarial self-review, not
-- one of R7-01 through R7-08 as originally listed, but the exact same bug
-- class as R7-05 (claim_negative_alert_send) -- and in the very function
-- R6-04 had already partially fixed for it.
--
-- request_notification_email_change() (migration 20260905193325) captures
-- clock_timestamp() correctly for its own cooldown check and budget count
-- -- both taken *after* the per-organization advisory lock, exactly as
-- R6-04's own comment explains is required. But the row it then inserts,
--
--   insert into private.notification_email_change_log (organization_id, status)
--   values (p_organization_id, 'reserved')
--
-- never sets reserved_at explicitly, so it falls back to the column's
-- default (`reserved_at timestamptz not null default now()`). now() is
-- frozen at THIS TRANSACTION'S OWN START -- before it waited on the
-- advisory lock -- so under real contention, the persisted reserved_at
-- understates when the reservation actually happened, by up to however
-- long this call waited behind another one for the same organization.
-- This is the identical mechanism R7-05 fixed in claim_negative_alert_send
-- (migration 20260906110000): a write made after a lock wait must use the
-- same clock_timestamp() value already captured for the freshness checks
-- in the same call, not a separate, later (or in this case, table-
-- default, earlier-than-expected) time source.
--
-- Consequence if left unfixed: a reservation's reserved_at could read
-- earlier than it truly was reserved, which both back-dates it within the
-- trailing-hour budget window (making it silently drop out of the budget
-- count sooner than it should) and, if reserved_at is ever used as an
-- audit/ordering signal elsewhere, could misorder it relative to
-- clock_timestamp()-stamped rows from other calls.
--
-- This migration's function body is otherwise byte-for-byte identical to
-- 20260905193325's version -- the only change is capturing one
-- v_now := clock_timestamp() immediately after the advisory lock (the same
-- point R6-04's version already conceptually treats as "now" for this
-- call) and reusing it for both existing checks and the new INSERT's
-- reserved_at, instead of two separate inline clock_timestamp() calls plus
-- an implicit now() default. Corrective migration, not an edit to
-- 20260905193325 in place, because that file is already applied to the
-- isolated test project (confirmed via `supabase migration list` this
-- session) -- editing an applied migration would reproduce the exact
-- bookkeeping-drift risk R7-03 spent this round repairing, even though
-- the file was never applied to production.
create or replace function public.request_notification_email_change(
  p_organization_id bigint,
  p_email text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_log_id bigint;
  v_recent_count int;
  v_cooldown_minutes int;
  v_org_hourly_budget int;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT201';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where organization_id = p_organization_id and user_id = v_user_id
  ) then
    raise exception 'not a member of this organization' using errcode = 'VT202';
  end if;

  select cooldown_minutes, org_hourly_budget
  into v_cooldown_minutes, v_org_hourly_budget
  from private.notification_email_change_config
  where organization_id = p_organization_id;
  if not found then
    v_cooldown_minutes := 5;
    v_org_hourly_budget := 5;
  end if;

  -- Serialized per organization -- without this, two concurrent requests
  -- for the same org could both read the same "under budget" snapshot and
  -- both proceed, overshooting the budget by as many concurrent callers as
  -- there were (exactly the round-3 R3-02 race, for a different budget).
  perform pg_advisory_xact_lock(hashtext('notification_email_change:' || p_organization_id::text));

  -- Captured once, immediately after the lock is acquired -- reused for
  -- every freshness decision AND the reservation's own reserved_at below.
  -- See this migration's header comment for why the previous version's
  -- reliance on the reserved_at column's now() default was wrong.
  v_now := clock_timestamp();

  if exists (
    select 1 from private.notification_email_change_log
    where organization_id = p_organization_id
      and reserved_at > v_now - (v_cooldown_minutes || ' minutes')::interval
  ) then
    raise exception 'too many notification-email change requests -- try again in a few minutes' using errcode = 'VT203';
  end if;

  select count(*) into v_recent_count
  from private.notification_email_change_log
  where organization_id = p_organization_id
    and status in ('reserved', 'delivered')
    and reserved_at > v_now - interval '1 hour';

  if v_recent_count >= v_org_hourly_budget then
    raise exception 'hourly notification-email change budget exceeded' using errcode = 'VT204';
  end if;

  insert into private.notification_email_change_log (organization_id, status, reserved_at)
  values (p_organization_id, 'reserved', v_now)
  returning id into v_log_id;

  -- Records the candidate address now (validated + rate-limited) but
  -- deliberately leaves the token hash/expiry null -- issue_notification_
  -- email_change_token() (service_role only) sets those once it mints the
  -- actual token, immediately afterward, from trusted server code.
  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending = p_email,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where id = p_organization_id;

  return v_log_id;
end;
$$;
