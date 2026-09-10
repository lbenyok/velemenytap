-- Round 10 independent review, finding R10-08 (P2), second half. A forward
-- migration; nothing already applied is edited.
--
-- THE DEFECT. The durable dirty flag guarantees that reconciliation work is
-- never LOST. It does not tell anyone that work is STUCK, and those are
-- different guarantees. The review demonstrated a healthy three-page
-- subscription scan taking 48 s against the unchanged 45 s lease: the write is
-- correctly rejected, the organization stays dirty, the sweep returns
-- `deferred` -- and the sweep route reports HTTP 200. Every retry with the
-- same latency reproduces it exactly, so a paid organization can sit locally
-- canceled indefinitely with every monitoring signal green.
--
-- Round 9 was right that `deferred` must not be an error: it is ordinary lease
-- contention and it IS self-correcting. What was wrong is the inference that
-- every deferred case is therefore self-correcting. The distinguishing signal
-- is not the outcome of one run, it is whether the organization is still dirty
-- after a long time -- which no query answered, because none existed.
--
-- The lease-renewal half of R10-08 (features/billing/reconcile.ts) fixes the
-- specific slow-scan cause. This is the general backstop for every cause,
-- including ones not yet found: elapsed dirty time is something this app can
-- always observe without being told what went wrong.
--
-- See BILLING_INVARIANTS.md § I8 and OPERATOR_RECOVERY.md § 3.

create function public.get_billing_reconciliation_backlog(
  p_older_than_seconds int default 3600,
  p_limit int default 50
)
returns table (
  organization_id bigint,
  dirty_since timestamptz,
  dirty_seconds integer,
  billing_sync_requested bigint,
  billing_sync_completed bigint,
  activation_requested bigint,
  activation_completed bigint,
  last_error text
)
language sql
security invoker
set search_path = ''
as $$
  select b.organization_id,
         b.reconciliation_dirty_since,
         floor(extract(epoch from clock_timestamp() - b.reconciliation_dirty_since))::integer,
         b.billing_sync_requested,
         b.billing_sync_completed,
         b.activation_requested,
         b.activation_completed,
         b.billing_sync_last_error
  from public.organization_billing b
  where b.needs_reconciliation
    and b.reconciliation_dirty_since is not null
    and b.reconciliation_dirty_since < clock_timestamp() - make_interval(secs => greatest(60, p_older_than_seconds))
  order by b.reconciliation_dirty_since
  limit least(200, greatest(1, p_limit));
$$;

revoke execute on function public.get_billing_reconciliation_backlog(int, int) from public, anon, authenticated;
grant execute on function public.get_billing_reconciliation_backlog(int, int) to service_role;
