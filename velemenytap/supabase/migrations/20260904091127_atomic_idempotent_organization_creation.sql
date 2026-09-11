-- Finding #8: createOrganizationAction (features/organizations/actions.ts)
-- did two separate round trips through the admin client -- insert the
-- organization, then insert its owner membership -- with no transaction
-- across them. If the process died between the two (a timeout, a crash,
-- the request getting aborted), the compensating "delete the org if the
-- membership insert failed" cleanup never runs, because there's no error
-- to catch: the org row is simply left behind with no owner and no way to
-- ever become accessible (there's deliberately no RLS INSERT policy on
-- organization_memberships for anyone but this action, and this action
-- only ever inserts a membership *at the moment it creates the org*).
--
-- Worse, nothing stopped a double-submit (a double-click, a network retry
-- replaying the POST, a user navigating back to /onboarding and
-- resubmitting) from creating a second organization for the same user, who
-- would then own two -- with which one they land in decided arbitrarily by
-- getCurrentOrganization()'s "earliest-joined" tiebreak, leaving the other
-- permanently invisible (there's no multi-org switcher in the dashboard).
--
-- Fixed with one atomic, idempotent Postgres function:
--   1. Atomic: both inserts happen in the same transaction as this
--      function's implicit one -- if anything fails partway through, all of
--      it rolls back. No compensating cleanup code needed anymore.
--   2. Idempotent: if the calling user already belongs to an organization,
--      this returns their existing one instead of creating a second --
--      calling it twice has the same effect as calling it once.
--   3. Per-user serialization: pg_advisory_xact_lock keyed on the user's id
--      closes the race a plain "check then insert" would still have --
--      two nearly-simultaneous calls for the same user would otherwise
--      both pass the "no existing org" check before either commits. The
--      lock is scoped to this transaction and a different user's calls
--      never contend with it.
--
-- SECURITY DEFINER, unlike the private.* helpers elsewhere in this schema,
-- because this must be callable directly by the authenticated user's own
-- session (not just from server-side admin code) to bootstrap their first
-- organization, and there is deliberately no INSERT policy on
-- organizations/organization_memberships for `authenticated` to invoke
-- through. Mitigations per the security checklist for a public-facing
-- DEFINER function: an explicit auth.uid() check, `set search_path = ''`,
-- and EXECUTE restricted to `authenticated` only (revoked from
-- public/anon).
-- The removed JS slugify() stripped accents (a Hungarian business name
-- routinely containsá/é/í/ó/ö/ő/ú/ü/ű) before collapsing non-alphanumeric
-- characters, e.g. "Kávézó Búza" -> "kavezo-buza". Without unaccent(), a
-- plain regexp replace would turn every accented letter into its own
-- hyphen ("k-v-z-b-za") instead -- a real UX regression for a
-- Hungarian-localized product, not just a cosmetic difference from the code
-- being moved into SQL.
create extension if not exists unaccent with schema extensions;

create or replace function public.create_organization_atomic(p_name text)
returns table (
  organization_id bigint,
  organization_name text,
  organization_slug text,
  newly_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_base_slug text;
  v_slug text;
  v_org_id bigint;
  v_org_name text;
  v_attempt int := 0;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT101';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text)::bigint);

  select o.id, o.name into v_org_id, v_org_name
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = v_user_id
  order by m.created_at asc
  limit 1;

  if v_org_id is not null then
    return query
      select v_org_id, v_org_name, o.slug, false from public.organizations o where o.id = v_org_id;
    return;
  end if;

  v_base_slug := trim(both '-' from
    regexp_replace(lower(extensions.unaccent(p_name)), '[^a-z0-9]+', '-', 'g'));
  if v_base_slug = '' then
    v_base_slug := 'organization';
  end if;
  v_slug := v_base_slug;

  loop
    begin
      insert into public.organizations (name, slug)
      values (p_name, v_slug)
      returning id, name into v_org_id, v_org_name;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception 'could not generate a unique organization slug' using errcode = 'VT102';
      end if;
      v_slug := v_base_slug || '-' || substr(md5(random()::text), 1, 4);
    end;
  end loop;

  insert into public.organization_memberships (organization_id, user_id, role)
  values (v_org_id, v_user_id, 'owner');

  return query select v_org_id, v_org_name, v_slug, true;
end;
$$;

revoke all on function public.create_organization_atomic(text) from public;
grant execute on function public.create_organization_atomic(text) to authenticated;
