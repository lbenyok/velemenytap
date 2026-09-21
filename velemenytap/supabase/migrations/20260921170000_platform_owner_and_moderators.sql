-- Existing explicitly provisioned platform administrators retain owner access.
-- Every future membership defaults to the restricted moderator role.
alter table public.platform_admins add column role text not null default 'owner'
  check (role in ('owner','moderator'));
alter table public.platform_admins alter column role set default 'moderator';

create table public.platform_team_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  target_id uuid not null,
  enabled boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.platform_team_audit enable row level security;
revoke all on public.platform_team_audit from public, anon, authenticated;
grant select, insert on public.platform_team_audit to service_role;
grant usage, select on sequence public.platform_team_audit_id_seq to service_role;

-- Move the already tested implementation intact, then add an owner-only gate.
-- The private schema is not exposed through PostgREST.
alter function public.set_billing_card_mode(uuid,bigint,text,integer,bigint) set schema private;
grant usage on schema private to service_role;
create function public.set_billing_card_mode(p_actor_id uuid, p_organization_id bigint,
  p_mode text, p_grace_days integer, p_expected_revision bigint)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.platform_admins where user_id = p_actor_id and role = 'owner' for share;
  if not found then raise exception 'Owner access required' using errcode = '42501'; end if;
  perform private.set_billing_card_mode(p_actor_id,p_organization_id,p_mode,p_grace_days,p_expected_revision);
end;
$$;
revoke all on function public.set_billing_card_mode(uuid,bigint,text,integer,bigint) from public, anon, authenticated;
grant execute on function public.set_billing_card_mode(uuid,bigint,text,integer,bigint) to service_role;

-- Also protect writes originating from the previous deployed server action.
create function private.guard_billing_monitor_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.platform_admins where user_id = new.updated_by and role = 'owner' for share;
  if not found then raise exception 'Owner access required' using errcode = '42501'; end if;
  return new;
end;
$$;
revoke all on function private.guard_billing_monitor_owner() from public, anon, authenticated;
create trigger guard_billing_monitor_owner before update on public.billing_monitor_settings
  for each row execute function private.guard_billing_monitor_owner();

create function public.set_platform_moderator(p_actor_id uuid, p_email text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target uuid; v_role text;
begin
  -- Serialize team changes before taking membership locks. Card operations
  -- take a shared actor membership lock and cannot pass a completed revocation.
  perform pg_advisory_xact_lock(hashtext('velemenytap_platform_team'));
  perform 1 from public.platform_admins where user_id = p_actor_id and role = 'owner' for share;
  if not found then raise exception 'Owner access required' using errcode = '42501'; end if;
  if p_enabled is null or p_email is null or char_length(btrim(p_email)) not between 3 and 320 then
    raise exception 'Invalid team request' using errcode = '22023';
  end if;
  -- Existing, verified accounts only; no arbitrary signup, invitation mail or
  -- authentication credential is created by this operation.
  select id into v_target from auth.users
    where lower(email) = lower(btrim(p_email)) and (not p_enabled or email_confirmed_at is not null) for share;
  if not found then raise exception 'Verified account not found' using errcode = 'P0002'; end if;
  select role into v_role from public.platform_admins where user_id = v_target for update;
  if v_target = p_actor_id or v_role = 'owner' then
    raise exception 'Owner membership cannot be changed here' using errcode = '42501';
  end if;
  if p_enabled and v_role is null then
    insert into public.platform_admins(user_id,role) values (v_target,'moderator');
  elsif not p_enabled and v_role = 'moderator' then
    delete from public.platform_admins where user_id = v_target;
  else return;
  end if;
  insert into public.platform_team_audit(actor_id,target_id,enabled) values (p_actor_id,v_target,p_enabled);
end;
$$;

create function public.get_platform_team(p_actor_id uuid)
returns table(user_id uuid, email text, role text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.platform_admins a where a.user_id = p_actor_id and a.role = 'owner' for share;
  if not found then raise exception 'Owner access required' using errcode = '42501'; end if;
  return query select a.user_id, u.email::text, a.role, a.created_at
    from public.platform_admins a join auth.users u on u.id=a.user_id
    order by a.created_at,a.user_id limit 100;
end;
$$;
revoke all on function public.set_platform_moderator(uuid,text,boolean),public.get_platform_team(uuid) from public, anon, authenticated;
grant execute on function public.set_platform_moderator(uuid,text,boolean),public.get_platform_team(uuid) to service_role;
