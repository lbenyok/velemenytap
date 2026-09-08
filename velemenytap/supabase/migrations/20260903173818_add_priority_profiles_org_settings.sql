-- Adds three independent things from the master build prompt's schema:
-- 1. feedback.priority -- derived from rating, not application logic, so it
--    can never drift out of sync with the rating that produced it.
-- 2. organizations.notification_email / logo_url -- settings fields with no
--    UI yet in this migration; the Settings page lands separately.
-- 3. profiles -- one row per auth user, auto-created on signup.

alter table public.feedback
  add column priority text generated always as (
    case
      when rating <= 2 then 'high'
      when rating = 3 then 'medium'
      else 'normal'
    end
  ) stored;

-- Supports "show unresolved high-priority feedback first" queries.
create index feedback_org_priority_idx on public.feedback (organization_id, priority);

alter table public.organizations add column notification_email text;
alter table public.organizations add column logo_url text;

alter table public.organizations
  add constraint organizations_notification_email_format
  check (notification_email is null or notification_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- profiles: one row per auth user. Only used for full_name today (nothing
-- reads it yet -- the dashboard header still shows org name, not the
-- signed-in user's name), added now because retrofitting it after real
-- users exist is more disruptive than creating it alongside an empty table.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- Auto-create a profile row when a new auth user is created. SECURITY
-- DEFINER is required here (the trigger fires as part of Supabase Auth's
-- own insert into auth.users, not as the end user), but it's narrowly
-- scoped: it only ever inserts a single row keyed to NEW.id, takes no
-- caller-supplied parameters, and is never callable directly (it's a
-- trigger function, not exposed as an RPC).
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
