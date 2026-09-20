-- Additive: existing public lookup/submission paths already reject inactive
-- cards under a row lock. Platform locks force that same state and prevent
-- tenants (including organization owners) from undoing it.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
grant select on public.platform_admins to authenticated;
grant all on public.platform_admins to service_role;
create policy platform_admin_self_read on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));

alter table public.nfc_cards
  add column platform_locked boolean not null default false,
  add column platform_previous_status text;
alter table public.nfc_cards add constraint platform_card_lock_consistent check (
  (platform_locked and status = 'inactive' and platform_previous_status in ('active', 'inactive') and platform_previous_status is not null)
  or (not platform_locked and platform_previous_status is null)
);

create function private.guard_platform_card_lock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('service_role', 'postgres') then
    if tg_op = 'INSERT' then
      if new.platform_locked or new.platform_previous_status is not null then
        raise exception 'Platform lock is administrator controlled' using errcode = '42501';
      end if;
    elsif new.id is distinct from old.id or new.public_id is distinct from old.public_id then
      -- Otherwise a tenant could move a locked URL onto a new, unlocked card.
      raise exception 'Card identity is immutable' using errcode = '42501';
    elsif new.platform_locked is distinct from old.platform_locked
       or new.platform_previous_status is distinct from old.platform_previous_status then
      raise exception 'Platform lock is administrator controlled' using errcode = '42501';
    end if;
  end if;
  if new.platform_locked and new.status <> 'inactive' then
    raise exception 'Card locked by platform administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_platform_card_lock() from public, anon, authenticated;
create trigger guard_platform_card_lock before insert or update on public.nfc_cards
  for each row execute function private.guard_platform_card_lock();

-- No tenant policies. Snapshot identifiers survive customer/card deletion.
create table public.platform_card_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  card_id bigint not null,
  organization_id bigint not null,
  locked boolean not null,
  reason text not null check (char_length(reason) between 2 and 500),
  previous_status text not null,
  resulting_status text not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.platform_card_audit enable row level security;
revoke all on public.platform_card_audit from anon, authenticated;
grant select, insert on public.platform_card_audit to service_role;
grant usage, select on sequence public.platform_card_audit_id_seq to service_role;
create index platform_card_audit_recent on public.platform_card_audit(created_at desc);

create function public.set_platform_card_lock(
  p_actor_id uuid, p_card_id bigint, p_locked boolean,
  p_expected_locked boolean, p_reason text
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_card public.nfc_cards%rowtype;
  v_status text;
begin
  -- Check again in this transaction, including against a concurrent revocation.
  perform 1 from public.platform_admins where user_id = p_actor_id for share;
  if not found then raise exception 'Not a platform administrator' using errcode = '42501'; end if;
  if p_locked is null or p_expected_locked is null or p_reason is null
     or char_length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'Invalid lock request' using errcode = '22023';
  end if;
  select * into v_card from public.nfc_cards where id = p_card_id for update;
  if not found then raise exception 'Card not found' using errcode = 'P0002'; end if;
  if v_card.platform_locked is distinct from p_expected_locked then
    raise exception 'Card changed; refresh before trying again' using errcode = '55000';
  end if;
  if v_card.platform_locked = p_locked then return; end if;
  v_status := case when p_locked then 'inactive' else v_card.platform_previous_status end;
  update public.nfc_cards set
    platform_locked = p_locked,
    platform_previous_status = case when p_locked then v_card.status else null end,
    status = v_status
  where id = p_card_id;
  insert into public.platform_card_audit(actor_id, card_id, organization_id, locked, reason, previous_status, resulting_status)
  values (p_actor_id, p_card_id, v_card.organization_id, p_locked, btrim(p_reason), v_card.status, v_status);
end;
$$;
revoke all on function public.set_platform_card_lock(uuid,bigint,boolean,boolean,text) from public, anon, authenticated;
grant execute on function public.set_platform_card_lock(uuid,bigint,boolean,boolean,text) to service_role;
