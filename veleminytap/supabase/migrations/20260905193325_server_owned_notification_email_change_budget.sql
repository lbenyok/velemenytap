-- Round-5 finding R5-12: request_notification_email_change() had no
-- cooldown or budget at all -- an authenticated member could trigger
-- unbounded real Resend sends to arbitrary addresses by repeatedly
-- submitting different candidate emails through the settings form.
--
-- This file has never been applied to production (see REVIEW_REQUEST.md /
-- DEPLOYMENT.md) -- it was rewritten in place for round 6 rather than
-- patched with a follow-up migration, since nothing outside this
-- repository's own isolated test project has ever depended on its
-- original shape. Round 6 found two further problems with that original
-- shape, both fixed here rather than shipped and corrected later:
--
--   R6-01 (HIGH): the original request_notification_email_change()
--   returned the raw confirmation token directly to its `authenticated`
--   caller -- exactly the same live-token-disclosure defect round 6 also
--   found (and a separate migration, 20260906090000, corrects) in the
--   round-3 version already in production. Fixed here by NEVER
--   generating/returning the token from the authenticated-callable
--   function at all: request_notification_email_change() now only
--   validates, rate-limits, and reserves a pending request, returning
--   just a `log_id` (not a secret). The actual token is minted by a new,
--   separate function -- issue_notification_email_change_token() --
--   granted to `service_role` ONLY, callable exclusively from trusted
--   server code via the admin client, never from a browser or any
--   authenticated session. This mirrors this project's own established
--   pattern of using a service_role-only boundary for anything that must
--   never reach client code (see lib/supabase/admin.ts).
--
--   R6-04 (MEDIUM): the original signature accepted p_cooldown_minutes/
--   p_org_hourly_budget as plain caller-supplied arguments with defaults
--   -- an authenticated caller could simply pass p_cooldown_minutes=0,
--   p_org_hourly_budget=999999 and disable its own rate limit entirely,
--   which is not a rate limit at all. Fixed by removing both from the
--   public signature; the actual values now live in a small, non-client-
--   writable config table (private.notification_email_change_config),
--   read internally by the function body. finalize_notification_email_
--   change_send() is also now service_role-only (previously callable by
--   `authenticated` with a caller-supplied delivery result) -- clients can
--   no longer mark their own reservation delivered/failed.
create table private.notification_email_change_log (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  status text not null default 'reserved' check (status in ('reserved', 'delivered', 'failed')),
  reserved_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz
);

create index notification_email_change_log_org_reserved_at_idx
  on private.notification_email_change_log (organization_id, reserved_at);

-- Not exposed to PostgREST (private schema) and no RLS policies for
-- anon/authenticated -- same pattern as private.alert_email_log. Selected
-- and updated only by the two service_role-only functions below (INVOKER,
-- so they need the explicit grants that follow), never by
-- request_notification_email_change() -- that one is SECURITY DEFINER and
-- reaches this table as its owning role regardless of service_role's own
-- grants, the same reasoning documented for private.alert_email_log.
alter table private.notification_email_change_log enable row level security;

-- R6-04: cooldown/budget are trusted server configuration now, not
-- authenticated-RPC parameters an org member's own session could simply
-- override. Keyed per organization, with a default (below) when no row
-- exists, rather than a single global row -- a shared, mutable global
-- would make tests that need to tune the boundary (a short cooldown, a
-- tiny budget) race against every OTHER concurrently-running test that
-- exercises this same RPC under its normal defaults, since this project's
-- e2e suite runs fully parallel across several workers. A per-
-- organization row lets a test insert its own override scoped to its own
-- seeded organization -- fully isolated from every other test, the same
-- isolation every other fixture in this suite already has, with no
-- serialization needed. Only service_role can read or write this table
-- directly (the explicit grants below); an authenticated org member has no
-- path to it at all, so this is not a second, indirect way to defeat the
-- rate limit the direct-RPC-parameter approach was removed for.
create table private.notification_email_change_config (
  organization_id bigint primary key references public.organizations (id) on delete cascade,
  cooldown_minutes int not null default 5,
  org_hourly_budget int not null default 5
);
alter table private.notification_email_change_config enable row level security;

grant select, update on private.notification_email_change_log to service_role;
grant select, insert, update, delete on private.notification_email_change_config to service_role;

drop function if exists public.request_notification_email_change(bigint, text, int, int, int);

-- SECURITY DEFINER, same reasoning as create_organization_atomic: must run
-- as the calling member's own session (auth.uid() + membership check), and
-- there is no broader UPDATE policy that would let a member set these
-- columns themselves. Returns ONLY a log_id -- see R6-01 above for why it
-- must never return the token itself.
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
  -- No override row is the normal case for every real organization --
  -- these are the actual production defaults, not just a fallback.
  if not found then
    v_cooldown_minutes := 5;
    v_org_hourly_budget := 5;
  end if;

  -- Serialized per organization -- without this, two concurrent requests
  -- for the same org could both read the same "under budget" snapshot and
  -- both proceed, overshooting the budget by as many concurrent callers as
  -- there were (exactly the round-3 R3-02 race, for a different budget).
  perform pg_advisory_xact_lock(hashtext('notification_email_change:' || p_organization_id::text));

  -- clock_timestamp(), not now() -- now() is frozen at this transaction's
  -- own START, not the moment this statement actually executes. Under
  -- genuine concurrency serialized through the advisory lock above, a
  -- transaction that started earliest (in wall-clock terms) is not
  -- guaranteed to also be the first to actually reach this check -- if it
  -- waits behind others, its own frozen now() can be EARLIER than a
  -- previously-inserted row's reserved_at (that row's own now(), taken at
  -- ITS transaction start, which could be later), making this exists()
  -- check spuriously true for a p_cooldown_minutes of 0. Confirmed
  -- empirically: this exact test flaked under real concurrency with now()
  -- before this fix. clock_timestamp() reflects real elapsed time at the
  -- point each waiting transaction actually resumes.
  if exists (
    select 1 from private.notification_email_change_log
    where organization_id = p_organization_id
      and reserved_at > clock_timestamp() - (v_cooldown_minutes || ' minutes')::interval
  ) then
    raise exception 'too many notification-email change requests -- try again in a few minutes' using errcode = 'VT203';
  end if;

  -- Counts 'reserved'+'delivered' rows in the trailing hour but excludes
  -- 'failed' ones -- an in-flight attempt must still count while
  -- unresolved (or two closely-spaced attempts could both slip past a
  -- budget check that only counted confirmed deliveries), but a transient
  -- delivery failure must not permanently consume real capacity the org
  -- never actually used. Same reasoning as claim_negative_alert_send's
  -- budget (R3-06). clock_timestamp() for the same reason as the cooldown
  -- check above.
  select count(*) into v_recent_count
  from private.notification_email_change_log
  where organization_id = p_organization_id
    and status in ('reserved', 'delivered')
    and reserved_at > clock_timestamp() - interval '1 hour';

  if v_recent_count >= v_org_hourly_budget then
    raise exception 'hourly notification-email change budget exceeded' using errcode = 'VT204';
  end if;

  insert into private.notification_email_change_log (organization_id, status)
  values (p_organization_id, 'reserved')
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

revoke execute on function public.request_notification_email_change(bigint, text) from public, anon, service_role;
grant execute on function public.request_notification_email_change(bigint, text) to authenticated;

-- R6-01: the only function that ever sees the plaintext token. SECURITY
-- INVOKER, not DEFINER -- its only caller is the admin client
-- (service_role), which already bypasses RLS at the connection-role level
-- (the same reasoning as submit_feedback_atomic/claim_negative_alert_send)
-- -- the explicit grants below are what it actually needs beyond RLS
-- bypass, the same "bypassrls is not a substitute for schema/table GRANTs"
-- lesson already documented for private.alert_email_log. EXECUTE is
-- granted to service_role ONLY -- never authenticated, never anon -- so no
-- browser or ordinary authenticated Supabase client can ever call this or
-- obtain a token through it, regardless of which organization it targets.
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
begin
  select organization_id into v_org_id
  from private.notification_email_change_log
  where id = p_log_id and status = 'reserved';

  if v_org_id is null then
    raise exception 'unknown or already-resolved notification-email change reservation' using errcode = 'VT205';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending_token_hash = encode(extensions.digest(v_raw_token, 'sha256'), 'hex'),
      notification_email_pending_expires_at = now() + (p_expires_in_minutes || ' minutes')::interval
  where id = v_org_id;

  return v_raw_token;
end;
$$;

revoke execute on function public.issue_notification_email_change_token(bigint, int) from public, anon, authenticated;
grant execute on function public.issue_notification_email_change_token(bigint, int) to service_role;

-- R6-04: was SECURITY DEFINER, callable by `authenticated` with a caller-
-- supplied p_delivered result and an auth.uid()+membership ownership check
-- standing in for authorization. Now service_role-only, called
-- exclusively from trusted server code immediately after that same
-- code's own request_notification_email_change()/
-- issue_notification_email_change_token() calls in the same request --
-- there is no longer an arbitrary caller whose identity needs checking,
-- so the ownership check is removed along with the authenticated grant,
-- and SECURITY INVOKER replaces DEFINER for the same least-privilege
-- reasoning as issue_notification_email_change_token() above (its only
-- caller already has, via the explicit grants below, everything it needs).
create or replace function public.finalize_notification_email_change_send(p_log_id bigint, p_delivered boolean)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update private.notification_email_change_log
  set status = case when p_delivered then 'delivered' else 'failed' end,
      delivered_at = case when p_delivered then now() else delivered_at end,
      failed_at = case when not p_delivered then now() else failed_at end
  where id = p_log_id
    and status = 'reserved';
end;
$$;

revoke execute on function public.finalize_notification_email_change_send(bigint, boolean) from public, anon, authenticated;
grant execute on function public.finalize_notification_email_change_send(bigint, boolean) to service_role;
