-- Found during an independent review, after this billing feature had
-- already been built out (Checkout, the Billing Portal, the webhook
-- handler, and the dashboard paywall): 20260905125856_add_organization_
-- billing.sql's own AFTER INSERT trigger only provisions a trial row for
-- organizations created from that migration forward -- every organization
-- that already existed before it ran has NO row in organization_billing
-- at all. getOrganizationBilling() then returns null for them
-- (features/billing/queries.ts's .maybeSingle()), isBillingActive treats
-- null as "not active" (features/billing/status.ts), and every dashboard
-- route redirects them to /dashboard/billing -- permanently, since
-- nothing ever creates the missing row for an organization that already
-- exists. Worse, reaching that paywall and trying to check out made it
-- WORSE, not better: getOrCreateStripeCustomerId's own UPDATE
-- (features/billing/actions.ts) matched zero rows for the identical
-- reason, so a real Stripe customer got created (and, had the flow been
-- completed, genuinely charged) without the resulting subscription ever
-- being persisted anywhere in this database -- confirmed by tracing the
-- exact code path, not just inferred from the schema. See the corrected
-- getOrCreateStripeCustomerId (features/billing/actions.ts) and
-- syncSubscription (app/api/webhooks/stripe/route.ts) for the other half
-- of this fix -- both now treat a missing/zero-row organization_billing
-- state as a hard error instead of silently proceeding.
--
-- Grandfathering policy (an explicit, documented product decision, not an
-- oversight): every organization that predates this table gets
-- `grandfathered_at` set to the moment this migration ran, and
-- isBillingActive treats a non-null grandfathered_at -- for an
-- organization that has never actually subscribed through Stripe -- as
-- always active, with no expiry. Unlike the normal no-card signup trial,
-- this is deliberately not time-limited: these are real organizations
-- that were already using the product with no advance warning that
-- billing was coming, and starting a short countdown for people
-- mid-use the moment this migration runs would be a surprise outage, not
-- a billing feature launch. Grandfathering stops applying the moment an
-- organization actually subscribes through Stripe (isBillingActive checks
-- stripe_subscription_id first) -- it is a one-time bridge, not a
-- permanent exemption once real billing is engaged. The owner can find
-- every organization still relying on it at any time with:
--   select organization_id from organization_billing
--   where grandfathered_at is not null and stripe_subscription_id is null;
-- and decide when (or whether) to ever revisit this -- nothing in this
-- migration or the application code ever expires it automatically.
alter table public.organization_billing
  add column grandfathered_at timestamptz;

insert into public.organization_billing (organization_id, status, grandfathered_at)
select o.id, 'trialing', now()
from public.organizations o
where not exists (
  select 1 from public.organization_billing b where b.organization_id = o.id
);

-- Stripe explicitly documents that webhook delivery is not guaranteed to
-- be in order. syncSubscription previously applied whichever event
-- arrived most recently in wall-clock delivery order, unconditionally
-- overwriting status/current_period_end/cancel_at_period_end -- so a
-- delayed older event (e.g. a redelivered "past_due" arriving after a
-- since-resolved "active") could silently stomp newer, correct state with
-- stale data. Each event's own `created` timestamp (from Stripe, not this
-- server's clock) is now compared against the last one actually applied
-- for that organization, and an older-or-equal event is skipped rather
-- than applied -- see the corrected syncSubscription, which folds this
-- check into the UPDATE's own WHERE clause so it's enforced atomically
-- even under concurrent webhook deliveries for the same organization, not
-- just sequential-but-reordered ones.
alter table public.organization_billing
  add column last_synced_event_created_at timestamptz;
