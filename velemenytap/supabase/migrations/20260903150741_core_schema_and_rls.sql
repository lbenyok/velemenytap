-- Core multi-tenant schema: organizations -> locations -> nfc_cards -> feedback,
-- plus organization_memberships connecting auth.users to organizations.
-- All tenant-owned tables are RLS-protected; see policies at the bottom.

-- ============================================================================
-- Helper schema and functions
-- ============================================================================

-- Non-exposed schema for internal helper functions used inside RLS policies.
-- Never grant PostgREST/API access to this schema.
create schema if not exists private;

-- Shared updated_at trigger.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- Tables
-- ============================================================================

create table public.organizations (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_key unique (slug),
  constraint organizations_name_not_blank check (btrim(name) <> ''),
  constraint organizations_slug_not_blank check (btrim(slug) <> '')
);

create table public.organization_memberships (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_memberships_org_user_key unique (organization_id, user_id)
);

create table public.locations (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  name text not null,
  address text,
  google_review_url text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_name_not_blank check (btrim(name) <> '')
);

create table public.nfc_cards (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  location_id bigint not null references public.locations (id) on delete cascade,
  public_id uuid not null default gen_random_uuid(),
  display_name text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nfc_cards_public_id_key unique (public_id)
);

create table public.feedback (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  location_id bigint not null references public.locations (id) on delete cascade,
  nfc_card_id bigint not null references public.nfc_cards (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  feedback_text text,
  status text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedback_text_length check (feedback_text is null or char_length(feedback_text) <= 5000)
);

-- ============================================================================
-- Indexes
-- (organization_id/location_id/nfc_card_id are FKs and are not auto-indexed
-- by Postgres; they also back the RLS predicates below, so they're required.)
-- ============================================================================

create index organization_memberships_organization_id_idx on public.organization_memberships (organization_id);
create index organization_memberships_user_id_idx on public.organization_memberships (user_id);

create index locations_organization_id_idx on public.locations (organization_id);

create index nfc_cards_organization_id_idx on public.nfc_cards (organization_id);
create index nfc_cards_location_id_idx on public.nfc_cards (location_id);

create index feedback_organization_id_idx on public.feedback (organization_id);
create index feedback_location_id_idx on public.feedback (location_id);
create index feedback_nfc_card_id_idx on public.feedback (nfc_card_id);
-- Feedback inbox: newest-first per org, and per-org unresolved filtering.
create index feedback_org_created_at_idx on public.feedback (organization_id, created_at desc);
create index feedback_org_status_idx on public.feedback (organization_id, status);

-- ============================================================================
-- updated_at triggers
-- ============================================================================

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create trigger organization_memberships_set_updated_at
  before update on public.organization_memberships
  for each row execute function private.set_updated_at();

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function private.set_updated_at();

create trigger nfc_cards_set_updated_at
  before update on public.nfc_cards
  for each row execute function private.set_updated_at();

create trigger feedback_set_updated_at
  before update on public.feedback
  for each row execute function private.set_updated_at();

-- ============================================================================
-- Prevent cross-tenant reassignment: organization_id must never change once
-- set, even for a user who happens to belong to more than one organization.
-- Without this, an UPDATE ... WITH CHECK policy alone could allow moving a
-- row from an org the user belongs to into another org they also belong to.
-- ============================================================================

create or replace function private.prevent_organization_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'organization_id cannot be changed';
  end if;
  return new;
end;
$$;

create trigger organization_memberships_immutable_org
  before update on public.organization_memberships
  for each row execute function private.prevent_organization_id_change();

create trigger locations_immutable_org
  before update on public.locations
  for each row execute function private.prevent_organization_id_change();

create trigger nfc_cards_immutable_org
  before update on public.nfc_cards
  for each row execute function private.prevent_organization_id_change();

create trigger feedback_immutable_org
  before update on public.feedback
  for each row execute function private.prevent_organization_id_change();

-- ============================================================================
-- Guard against denormalized organization_id/location_id drifting from the
-- true hierarchy (organizations -> locations -> nfc_cards -> feedback).
-- organization_id is duplicated onto nfc_cards and feedback for RLS/query
-- performance; without this check a member could insert e.g. an nfc_card
-- whose organization_id passes the RLS check but whose location_id points
-- at a different org's location, corrupting the tenant boundary for
-- anything that trusts the denormalized organization_id column.
-- ============================================================================

create or replace function private.validate_nfc_card_organization()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_location_org_id bigint;
begin
  select organization_id into v_location_org_id
  from public.locations
  where id = new.location_id;

  if v_location_org_id is null then
    raise exception 'location % does not exist', new.location_id;
  end if;

  if v_location_org_id <> new.organization_id then
    raise exception 'nfc_card organization_id must match its location''s organization_id';
  end if;

  return new;
end;
$$;

create trigger nfc_cards_validate_organization
  before insert or update on public.nfc_cards
  for each row execute function private.validate_nfc_card_organization();

create or replace function private.validate_feedback_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_card_org_id bigint;
  v_card_location_id bigint;
begin
  select organization_id, location_id into v_card_org_id, v_card_location_id
  from public.nfc_cards
  where id = new.nfc_card_id;

  if v_card_org_id is null then
    raise exception 'nfc_card % does not exist', new.nfc_card_id;
  end if;

  if v_card_org_id <> new.organization_id or v_card_location_id <> new.location_id then
    raise exception 'feedback organization_id/location_id must match its nfc_card''s organization_id/location_id';
  end if;

  return new;
end;
$$;

create trigger feedback_validate_consistency
  before insert or update on public.feedback
  for each row execute function private.validate_feedback_consistency();

-- ============================================================================
-- RLS helper: is the current user a member of the given organization?
-- SECURITY DEFINER so it can read organization_memberships without
-- recursively triggering that table's own RLS policy.
-- ============================================================================

create or replace function private.is_org_member(p_organization_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
  );
$$;

revoke execute on function private.is_org_member(bigint) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_org_member(bigint) to authenticated;

-- ============================================================================
-- RLS policies
--
-- Note on writes: creating an organization (and its first owner membership)
-- and submitting public feedback both happen through privileged server-side
-- code paths using the secret key (which bypasses RLS), not through these
-- policies. That's why organizations/organization_memberships have no INSERT
-- policy here, and feedback has no INSERT policy for anon/authenticated.
-- Deferred to the auth/org flow (step 5) and the public NFC endpoint (step 6).
-- ============================================================================

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.locations enable row level security;
alter table public.nfc_cards enable row level security;
alter table public.feedback enable row level security;

-- organizations: members can read; members can update settings.
create policy organizations_select on public.organizations
  for select
  to authenticated
  using (private.is_org_member(id));

create policy organizations_update on public.organizations
  for update
  to authenticated
  using (private.is_org_member(id))
  with check (private.is_org_member(id));

-- organization_memberships: members can see their org's roster.
create policy organization_memberships_select on public.organization_memberships
  for select
  to authenticated
  using (private.is_org_member(organization_id));

-- locations: members can read, create, and update.
create policy locations_select on public.locations
  for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy locations_insert on public.locations
  for insert
  to authenticated
  with check (private.is_org_member(organization_id));

create policy locations_update on public.locations
  for update
  to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));

-- nfc_cards: members can read, create, and update (e.g. activate/deactivate).
create policy nfc_cards_select on public.nfc_cards
  for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy nfc_cards_insert on public.nfc_cards
  for insert
  to authenticated
  with check (private.is_org_member(organization_id));

create policy nfc_cards_update on public.nfc_cards
  for update
  to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));

-- feedback: members can read and update status/notes. No insert/delete
-- policy for anon or authenticated — see note above.
create policy feedback_select on public.feedback
  for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy feedback_update on public.feedback
  for update
  to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));
