-- Independent organization-wide payment hold. Never rewrites card status or
-- platform_locked, so payment recovery cannot undo an owner's manual lock.
create table public.billing_card_controls (
  organization_id bigint primary key references public.organizations(id) on delete cascade,
  mode text not null default 'manual' check (mode in ('manual','automatic')),
  grace_days integer not null default 3 check (grace_days between 0 and 30),
  blocked boolean not null default false,
  overdue_since timestamptz,
  checked_at timestamptz,
  state text not null default 'unknown' check (state in ('unknown','ok','attention','grace','overdue','blocked')),
  last_notice_state text,
  notice_sequence bigint not null default 0,
  revision bigint not null default 0
);
create table public.billing_monitor_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  recipient text,
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.billing_monitor_settings(id) values (true);
create table public.billing_owner_notices (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.billing_card_controls(organization_id) on delete cascade,
  sequence bigint not null,
  recipient text not null,
  message text not null,
  sender text,
  created_at timestamptz not null default clock_timestamp(),
  first_attempt_at timestamptz,
  lease_until timestamptz,
  lease_owner uuid,
  sent_at timestamptz,
  provider_id text,
  last_error text,
  needs_review boolean not null default false,
  unique(organization_id, sequence)
);
create table public.billing_control_audit (
  id bigint generated always as identity primary key,
  organization_id bigint not null,
  actor_id uuid not null,
  mode text not null,
  grace_days integer not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.billing_card_controls enable row level security;
alter table public.billing_monitor_settings enable row level security;
alter table public.billing_owner_notices enable row level security;
alter table public.billing_control_audit enable row level security;
revoke all on public.billing_card_controls, public.billing_monitor_settings,
  public.billing_owner_notices, public.billing_control_audit from public, anon, authenticated;
grant all on public.billing_card_controls, public.billing_monitor_settings,
  public.billing_owner_notices, public.billing_control_audit to service_role;
grant usage, select on sequence public.billing_owner_notices_id_seq, public.billing_control_audit_id_seq to service_role;
create index billing_controls_due on public.billing_card_controls(checked_at nulls first,organization_id);

create function private.initialize_billing_card_control() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.billing_card_controls(organization_id) values (new.id);
  return new;
end;
$$;
revoke all on function private.initialize_billing_card_control() from public, anon, authenticated;
create trigger initialize_billing_card_control after insert on public.organizations
  for each row execute function private.initialize_billing_card_control();
insert into public.billing_card_controls(organization_id) select id from public.organizations;

-- Feedback already holds card -> location -> organization locks. This final
-- shared lock serializes insertion with an organization hold, including direct
-- service-role inserts. Evaluators never acquire card/location locks.
create function private.enforce_billing_card_hold() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_blocked boolean;
begin
  select blocked into v_blocked from public.billing_card_controls
    where organization_id = new.organization_id for share;
  if not found then raise exception 'Billing control unavailable' using errcode = 'VT004'; end if;
  if v_blocked then raise exception 'card is inactive' using errcode = 'VT002'; end if;
  return new;
end;
$$;
revoke all on function private.enforce_billing_card_hold() from public, anon, authenticated;
create trigger enforce_billing_card_hold before insert on public.feedback
  for each row execute function private.enforce_billing_card_hold();

-- Lock order for monitor writers: billing -> control -> notice. Read the clock
-- only after locks, and only decide from complete, recently reconciled state.
create function public.evaluate_billing_card_control(p_organization_id bigint)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  b public.organization_billing%rowtype;
  c public.billing_card_controls%rowtype;
  s public.billing_monitor_settings%rowtype;
  v_now timestamptz;
  v_active boolean;
  v_attention boolean;
  v_state text;
  v_name text;
  v_message text;
begin
  select * into b from public.organization_billing where organization_id = p_organization_id for share;
  select * into c from public.billing_card_controls where organization_id = p_organization_id for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if b.organization_id is null or (b.stripe_customer_id is not null and (
    b.last_synced_at is null or b.last_synced_at < v_now - interval '2 hours'
    or b.needs_reconciliation or b.billing_sync_requested > b.billing_sync_completed
    or b.billing_sync_last_error is not null
  )) then
    update public.billing_card_controls set checked_at = v_now, state = 'unknown'
      where organization_id = p_organization_id;
    return; -- An outage must not create a new suspension or falsely clear one.
  end if;
  v_active := (b.stripe_subscription_id is not null and b.status in ('active','trialing'))
    or (b.activated_at is null and (b.grandfathered_at is not null or b.trial_ends_at > v_now));
  v_active := coalesce(v_active, false);
  v_attention := not v_active or (b.stripe_subscription_id is not null and b.status in ('past_due','unpaid','incomplete','paused'));
  if v_active then
    c.overdue_since := null;
    c.blocked := false;
    v_state := case when v_attention then 'attention' else 'ok' end;
  else
    -- Grace begins on the first verified observation, never backdated when
    -- installing the feature on existing customers or recovering an outage.
    c.overdue_since := coalesce(c.overdue_since, v_now);
    c.blocked := c.mode = 'automatic' and v_now >= c.overdue_since + make_interval(days => c.grace_days);
    v_state := case when c.blocked then 'blocked'
      when v_now < c.overdue_since + make_interval(days => c.grace_days) then 'grace' else 'overdue' end;
  end if;
  select * into s from public.billing_monitor_settings where id;
  if s.enabled and s.recipient is not null and c.last_notice_state is distinct from v_state
    and (v_state <> 'ok' or c.last_notice_state is not null) then
    select name into v_name from public.organizations where id = p_organization_id;
    c.notice_sequence := c.notice_sequence + 1;
    v_message := coalesce(v_name,'Vállalkozás') || ' (#' || p_organization_id || ')' || E'\n' ||
      case v_state when 'ok' then 'A hozzáférés ismét rendezett. A fizetési tiltás feloldva; a kézi kártyazárolások megmaradnak.'
      when 'attention' then 'Fizetési probléma látható, de a jelenlegi jogosultság még érvényes. A kártyák nincsenek fizetési okból tiltva.'
      when 'blocked' then 'A türelmi idő lejárt. Az automatikus mód letiltotta a vállalkozás kártyalinkjeit.'
      when 'grace' then 'A hozzáférés nem rendezett. A türelmi idő elkezdődött; fizetési tiltás még nincs.'
      else 'A türelmi idő lejárt. Kézi mód van érvényben: ellenőrizd a fizetést, és te dönthetsz a zárolásról.' end || E'\n' ||
      'Mód: ' || case c.mode when 'automatic' then 'automatikus' else 'kézi' end ||
      E'\nTürelmi idő: ' || c.grace_days || ' nap.' ||
      E'\nEllenőrzés (UTC): ' || to_char(v_now at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') ||
      E'\nAdminpanel: https://velemenytap.com/admin?org=' || p_organization_id ||
      E'\nEz az ellenőrzéskori állapot. Intézkedés előtt nyisd meg az aktuális adatokat.';
    insert into public.billing_owner_notices(organization_id, sequence, recipient, message)
      values (p_organization_id, c.notice_sequence, s.recipient, v_message);
    c.last_notice_state := v_state;
  end if;
  update public.billing_card_controls set overdue_since = c.overdue_since,
    blocked = c.blocked, state = v_state, checked_at = v_now,
    last_notice_state = c.last_notice_state, notice_sequence = c.notice_sequence
    where organization_id = p_organization_id;
end;
$$;

create function public.set_billing_card_mode(p_actor_id uuid, p_organization_id bigint,
  p_mode text, p_grace_days integer, p_expected_revision bigint)
returns void language plpgsql security invoker set search_path = '' as $$
declare c public.billing_card_controls%rowtype;
begin
  perform 1 from public.platform_admins where user_id = p_actor_id for share;
  if not found then raise exception 'Not a platform administrator' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('manual','automatic') or p_grace_days is null or p_grace_days not between 0 and 30 then
    raise exception 'Invalid mode' using errcode = '22023';
  end if;
  perform 1 from public.organization_billing where organization_id = p_organization_id for share;
  select * into c from public.billing_card_controls where organization_id = p_organization_id for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'Refresh before saving' using errcode = '55000'; end if;
  update public.billing_card_controls set mode = p_mode, grace_days = p_grace_days,
    revision = revision + 1, blocked = case when p_mode = 'manual' then false else blocked end,
    last_notice_state = case when mode is distinct from p_mode then null else last_notice_state end
    where organization_id = p_organization_id;
  insert into public.billing_control_audit(organization_id, actor_id, mode, grace_days)
    values (p_organization_id,p_actor_id,p_mode,p_grace_days);
  perform public.evaluate_billing_card_control(p_organization_id);
end;
$$;

-- Claim one durable, immutable notification. 23h replay horizon stays inside
-- Resend's documented 24h idempotency window; ambiguous older sends require
-- operator inspection instead of unbounded automatic duplicate messages.
create function public.claim_billing_owner_notice(p_sender text) returns setof public.billing_owner_notices
language plpgsql security invoker set search_path = '' as $$
declare n public.billing_owner_notices%rowtype; v_now timestamptz;
begin
  if p_sender is null or char_length(p_sender) not between 3 and 320 then raise exception 'Missing sender'; end if;
  for n in select * from public.billing_owner_notices
    where sent_at is null and not needs_review
      and (lease_until is null or lease_until < clock_timestamp())
    order by id for update skip locked limit 20
  loop
    v_now := clock_timestamp();
    if n.first_attempt_at is not null and n.first_attempt_at < v_now - interval '23 hours' then
      update public.billing_owner_notices set needs_review = true, last_error = 'Küldési eredmény bizonytalan; ellenőrizd a szolgáltatónál.' where id = n.id;
    else
      return query update public.billing_owner_notices set
        first_attempt_at = coalesce(first_attempt_at, v_now), lease_until = v_now + interval '5 minutes',
        sender = coalesce(sender, p_sender),
        lease_owner = gen_random_uuid()
        where id = n.id returning *;
      return;
    end if;
  end loop;
end;
$$;
revoke all on function public.evaluate_billing_card_control(bigint),
  public.set_billing_card_mode(uuid,bigint,text,integer,bigint),
  public.claim_billing_owner_notice(text) from public, anon, authenticated;
grant execute on function public.evaluate_billing_card_control(bigint),
  public.set_billing_card_mode(uuid,bigint,text,integer,bigint),
  public.claim_billing_owner_notice(text) to service_role;
