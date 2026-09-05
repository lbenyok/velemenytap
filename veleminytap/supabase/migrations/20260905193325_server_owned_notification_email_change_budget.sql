-- Round-5 finding R5-12: request_notification_email_change() had no
-- cooldown or budget at all -- an authenticated member could trigger
-- unbounded real Resend sends to arbitrary addresses by repeatedly
-- submitting different candidate emails through the settings form.
-- Public signup means an attacker can obtain the required authenticated
-- session (their own throwaway organization) for free, so this was a
-- genuinely unbounded spam-relay vector, not one requiring privileged
-- access.
--
-- Fixed with the exact same dual-control pattern already proven for the
-- negative-feedback alert (round 2/3, R2-08/R3-02/R3-06): a per-
-- organization cooldown, an hourly budget, both serialized via advisory
-- lock so concurrent requests can't both slip past the same "under
-- budget" snapshot, and a reservation/attempt log with an explicit status
-- (not an unconditional record of a send) so a transient Resend failure
-- doesn't permanently burn real capacity the org never actually used.
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
-- anon/authenticated -- same pattern as private.alert_email_log. Only
-- touched from inside the SECURITY DEFINER functions below, which run
-- with the function owner's privileges regardless of RLS.
alter table private.notification_email_change_log enable row level security;

drop function if exists public.request_notification_email_change(bigint, text, int);

create or replace function public.request_notification_email_change(
  p_organization_id bigint,
  p_email text,
  p_expires_in_minutes int default 1440,
  p_cooldown_minutes int default 5,
  p_org_hourly_budget int default 5
)
returns table (token text, log_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_raw_token text;
  v_log_id bigint;
  v_recent_count int;
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

  -- Serialized per organization -- without this, two concurrent requests
  -- for the same org could both read the same "under budget" snapshot and
  -- both proceed, overshooting the budget by as many concurrent callers as
  -- there were (exactly the round-3 R3-02 race, for a different budget).
  perform pg_advisory_xact_lock(hashtext('notification_email_change:' || p_organization_id::text));

  if exists (
    select 1 from private.notification_email_change_log
    where organization_id = p_organization_id
      and reserved_at > now() - (p_cooldown_minutes || ' minutes')::interval
  ) then
    raise exception 'too many notification-email change requests -- try again in a few minutes' using errcode = 'VT203';
  end if;

  -- Counts 'reserved'+'delivered' rows in the trailing hour but excludes
  -- 'failed' ones -- an in-flight attempt must still count while
  -- unresolved (or two closely-spaced attempts could both slip past a
  -- budget check that only counted confirmed deliveries), but a transient
  -- delivery failure must not permanently consume real capacity the org
  -- never actually used. Same reasoning as claim_negative_alert_send's
  -- budget (R3-06).
  select count(*) into v_recent_count
  from private.notification_email_change_log
  where organization_id = p_organization_id
    and status in ('reserved', 'delivered')
    and reserved_at > now() - interval '1 hour';

  if v_recent_count >= p_org_hourly_budget then
    raise exception 'hourly notification-email change budget exceeded' using errcode = 'VT204';
  end if;

  insert into private.notification_email_change_log (organization_id, status)
  values (p_organization_id, 'reserved')
  returning id into v_log_id;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending = p_email,
      notification_email_pending_token_hash = encode(extensions.digest(v_raw_token, 'sha256'), 'hex'),
      notification_email_pending_expires_at = now() + (p_expires_in_minutes || ' minutes')::interval
  where id = p_organization_id;

  return query select v_raw_token, v_log_id;
end;
$$;

revoke execute on function public.request_notification_email_change(bigint, text, int, int, int) from public, anon, service_role;
grant execute on function public.request_notification_email_change(bigint, text, int, int, int) to authenticated;

-- SECURITY DEFINER, unlike finalize_negative_alert_send -- that one is
-- INVOKER because its only caller is the admin client (service_role),
-- which already has grants on the private schema. This function's only
-- caller is the settings Server Action running as the signed-in member's
-- own session (request_notification_email_change is called the same way,
-- for the same reason), which has no grant on private.
-- notification_email_change_log at all -- INVOKER here would simply fail.
-- The membership check below is what keeps this scoped to the caller's
-- own organization despite the elevated privilege, the same mitigation
-- pattern as every other DEFINER function in this schema.
create or replace function public.finalize_notification_email_change_send(p_log_id bigint, p_delivered boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT201';
  end if;

  update private.notification_email_change_log l
  set status = case when p_delivered then 'delivered' else 'failed' end,
      delivered_at = case when p_delivered then now() else l.delivered_at end,
      failed_at = case when not p_delivered then now() else l.failed_at end
  where l.id = p_log_id
    and l.status = 'reserved'
    and exists (
      select 1 from public.organization_memberships m
      where m.organization_id = l.organization_id and m.user_id = v_user_id
    );
end;
$$;

revoke execute on function public.finalize_notification_email_change_send(bigint, boolean) from public, anon, service_role;
grant execute on function public.finalize_notification_email_change_send(bigint, boolean) to authenticated;
