-- Fourth independent review's own three-reviewer adversarial audit
-- (2026-09-08). Migrations up through 20260907230000 have already been
-- applied to the isolated test project -- this is a forward migration, not
-- a rewrite, the same reasoning as those migrations' own header comments.
--
-- FINDING (MEDIUM, independent migrations/deployment reviewer):
-- needs_reconciliation has no durable "confirmed clean, nothing to
-- reconcile" outcome. reconcileOrganizationBilling's "no_subscriptions"
-- path called release_reconciliation_lease -- but that function is
-- designed and documented as the ERROR/ABANDONMENT cleanup path (a
-- reconciliation that claimed the lease and then hit an unexpected
-- problem before writing) and unconditionally re-marks the organization
-- dirty in the same statement, regardless of why it was called. There was
-- no way to say "I definitively checked Stripe, there is genuinely
-- nothing to reconcile for this organization right now" without ALSO
-- leaving it permanently flagged dirty -- any organization that ever
-- reaches "has a Stripe customer, but zero approved subscriptions" (an
-- abandoned checkout, a stale success-URL visit, a manual resync click on
-- a still-trialing organization) gets swept every 15 minutes by
-- .github/workflows/reconcile-billing-sweep.yml forever, re-hitting the
-- Stripe API for no reason. Not an entitlement or security bug --
-- isBillingActive never reads needs_reconciliation -- but a real,
-- permanent operational-cost loop once triggered.
--
-- Fixed with a distinct function for the distinct case: releases the
-- lease AND clears needs_reconciliation/reconciliation_dirty_since,
-- conditioned on the caller still owning the lease (the same CAS
-- discipline as release_reconciliation_lease) -- but, unlike that
-- function, does NOT unconditionally re-mark the organization dirty
-- afterward. Used only when a reconciliation attempt has genuinely
-- confirmed there is nothing to do, never as a substitute for
-- release_reconciliation_lease's own error-path behavior (which must keep
-- defaulting to "assume dirty, let something re-check" whenever the
-- caller does NOT know whether its work actually completed).
create or replace function public.clear_reconciliation_dirty(
  p_organization_id bigint,
  p_owner text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_applied boolean;
begin
  update public.organization_billing
  set reconciliation_lease_owner = null,
      reconciliation_lease_expires_at = null,
      needs_reconciliation = false,
      reconciliation_dirty_since = null
  where organization_id = p_organization_id
    and reconciliation_lease_owner = p_owner
  returning true into v_applied;

  return coalesce(v_applied, false);
end;
$$;

revoke execute on function public.clear_reconciliation_dirty(bigint, text) from public, anon, authenticated;
grant execute on function public.clear_reconciliation_dirty(bigint, text) to service_role;
