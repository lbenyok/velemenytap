-- Fourth independent review's own three-reviewer adversarial audit
-- (2026-09-08). Migration 20260907210000 has already been applied to the
-- isolated test project -- this is a forward migration correcting it, not
-- a rewrite, the same reasoning as that migration's own header comment.
--
-- FINDING (MEDIUM, independent concurrency reviewer): claim_reconciliation_
-- lease's SUCCESS path never touched needs_reconciliation -- only its
-- failure branch (another reconciler already holds a live lease) did. A
-- caller that successfully claims the lease and then suffers a genuine
-- process-level kill (a Vercel function timeout, an OOM, a container
-- cutover -- not a catchable JS exception, which reconcile.ts's own
-- try/catch already handles) before ever calling write_reconciliation_
-- result/write_activation/release_reconciliation_lease leaves the
-- organization's row holding a soon-to-expire lease with
-- needs_reconciliation still false. The scheduled sweep
-- (app/api/admin/reconcile-billing-sweep/route.ts) scans strictly
-- `where needs_reconciliation = true` -- it has no independent notion of
-- "a lease is held but its expiry has long since passed with no
-- resolution," so this organization is invisible to it until some
-- unrelated trigger (a future webhook, a page visit) happens to reconcile
-- it again. This directly contradicts this migration's own header comment
-- ("needs_reconciliation is set durably in the SAME statement... so this
-- organization is never permanently dropped") and DECISIONS.md's
-- "guaranteed convergence" claim, for exactly this one abandonment path.
--
-- Fixed the same way every OTHER abandonment path in this schema already
-- works: mark the organization dirty in the SAME statement that claims the
-- lease, not only when the claim fails. This flips the invariant from
-- "dirty only once something has gone wrong" to "dirty from the moment
-- reconciliation is attempted, clean only once it has PROVABLY completed"
-- -- write_reconciliation_result/write_activation's own success paths
-- already clear needs_reconciliation, so a normal, uninterrupted
-- reconciliation still ends with the flag correctly false. A concurrent
-- sweep run landing mid-flight (lease genuinely still held by a live
-- process) simply re-observes "still dirty, lease live" and is a harmless
-- no-op, exactly like any other lease-contention case this schema already
-- handles.
create or replace function public.claim_reconciliation_lease(
  p_organization_id bigint,
  p_lease_seconds int default 45
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
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

  if v_current.reconciliation_lease_owner is not null
     and v_current.reconciliation_lease_expires_at is not null
     and v_current.reconciliation_lease_expires_at > v_now
  then
    update public.organization_billing
    set needs_reconciliation = true,
        reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
    where organization_id = p_organization_id;
    return null;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  update public.organization_billing
  set reconciliation_lease_owner = v_owner,
      reconciliation_lease_expires_at = v_now + (p_lease_seconds || ' seconds')::interval,
      -- The fix: dirty from the moment a lease is successfully claimed,
      -- not only when a claim fails. write_reconciliation_result/
      -- write_activation's own success paths are what clear this back to
      -- false -- an interrupted reconciliation (of any kind, catchable or
      -- not) now always leaves the organization findable by the sweep.
      needs_reconciliation = true,
      reconciliation_dirty_since = coalesce(reconciliation_dirty_since, v_now)
  where organization_id = p_organization_id;

  return v_owner;
end;
$$;

revoke execute on function public.claim_reconciliation_lease(bigint, int) from public, anon, authenticated;
grant execute on function public.claim_reconciliation_lease(bigint, int) to service_role;
