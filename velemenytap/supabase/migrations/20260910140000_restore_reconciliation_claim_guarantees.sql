-- Round 10, self-inflicted regression -- caught by the isolated browser suite,
-- not by any reasoning about the change.
--
-- 20260910100000 had to re-create claim_reconciliation_lease because its return
-- type changed (the activation generation was removed). Re-creating it dropped
-- three behaviours the function had accumulated across earlier rounds, none of
-- which had anything to do with the change being made:
--
--   1. THE CRASH GAP (migration 20260907230000). A SUCCESSFUL claim must mark
--      the organization dirty in the same statement. Without it there is a
--      window between claiming the lease and writing a result in which a
--      crashed worker leaves NO durable evidence that reconciliation is owed --
--      the lease simply expires and nothing ever selects the organization
--      again. That is the exact "an organization can never be silently and
--      permanently dropped" guarantee the whole lease design rests on.
--
--   2. THE REFUSED CONTENDER'S OBLIGATION. A claim that LOSES must also mark
--      dirty, so the event that arrived while somebody else held the lease is
--      not lost when the holder's own completing write clears the flag.
--
--   3. THE LEASE CAP. `least(300, p_lease_seconds)` bounds how long a caller
--      may hold an organization, so a bad argument cannot lock one out for an
--      arbitrary period.
--
-- Restored here rather than by editing 20260910100000, which is already applied
-- to the isolated test project -- the same reasoning migration
-- 20260906120000's header records for the same situation.
--
-- Worth stating plainly, because it is the point of the round: this was a
-- regression introduced WHILE fixing a review's findings, in a function nobody
-- had asked me to touch, and every static check passed. It was found only by
-- running the suite that exercises the guarantee end to end. Re-creating a
-- function is not a mechanical operation -- it silently discards everything
-- previous rounds added to the version being replaced.

create or replace function public.claim_reconciliation_lease(
  p_organization_id bigint,
  p_lease_seconds int default 45
)
returns table (
  owner_token text,
  requested_generation bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_current public.organization_billing%rowtype;
  v_owner text;
begin
  select * into v_current
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- Read the clock after the lock is granted, never before waiting for it.
  v_now := clock_timestamp();

  if v_current.reconciliation_lease_owner is not null
     and v_current.reconciliation_lease_expires_at is not null
     and v_current.reconciliation_lease_expires_at > v_now
  then
    -- (2) A refused contender still registers that there is work to do, so the
    -- current holder's completing write cannot discard the event that arrived
    -- while it was running.
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set reconciliation_lease_owner = v_owner,
      -- (3) Bounded, so a bad argument cannot hold an organization for an
      -- arbitrary period.
      reconciliation_lease_expires_at = v_now + make_interval(secs => greatest(1, least(300, p_lease_seconds))),
      billing_sync_last_attempt_at = v_now,
      -- (1) The crash gap: dirty from the moment ownership is taken, so a
      -- worker that dies before writing anything still leaves durable evidence
      -- that this organization is owed a reconciliation.
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
  where organization_id = p_organization_id;

  return query select v_owner, v_current.billing_sync_requested;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;
