-- Round-14 R14-02. The documented staged rollout ends with the WRONG version
-- of confirm_notification_email_change installed, reintroducing a bug an
-- earlier round had already fixed.
--
-- Two migrations define that function:
--
--   * 20260909110000 (in --expand) -- takes the row lock, THEN reads
--     clock_timestamp(). The correct, current implementation.
--   * 20260906090000 (held back to --enforce, because it revokes a grant the
--     CURRENTLY DEPLOYED application still needs) -- also does a
--     `create or replace` of the same function, using `> now()` and no
--     explicit lock. The old implementation.
--
-- Because enforce runs after expand, finalize overwrites the fixed function
-- with the old one. The end state of a documented rollout is not the end state
-- of a sorted replay, and every check this project owns replays in filename
-- order -- which is exactly why 48 green harness checks never saw it. The
-- reviewer reproduced it in real PostgreSQL: after the two enforce migrations
-- the installed function contains `> now()` again, and a confirmation held
-- behind a plain row lock until after its token expired was still accepted.
--
-- Fixed by restoring the correct definition as the LAST thing the rollout
-- does. 20260906090000 is deliberately left alone: its reason for being in
-- enforce (revoking a grant live code still uses) is sound and unrelated, and
-- editing a migration to fix an ordering problem hides the ordering problem.
-- This file is appended to the --enforce list in DEPLOYMENT.md section 7 after
-- both of those, so the final definition is this one in either order.
--
-- The general lesson, recorded because it will recur: a migration that does
-- `create or replace` on a function shared with another migration is not
-- order-independent, and a manifest that reorders them changes behaviour
-- silently. TEST_PLAN.md now carries a gate for the staged order, not just the
-- sorted one.

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
