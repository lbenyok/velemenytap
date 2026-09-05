-- Adds subscription billing (Stripe). An organization must be able to pay
-- for VéleményTap; the paywall itself gates only the operator dashboard
-- (per product decision) -- public NFC card taps and feedback submission
-- keep working regardless of subscription status, since a physical card
-- already sold and sitting on a customer's counter should never stop
-- collecting real feedback because of a billing lapse.
--
-- Separate table, not columns on organizations, for the same reason
-- notification-email verification (round 3) and the alert cooldown (round
-- 3) got their own protected columns: this is privileged, server-owned
-- state that must never be writable through the same client-side update
-- path an owner uses to rename their organization or change branding.
-- Only the Stripe webhook handler and the checkout/portal Server Actions
-- (both using the admin client, which bypasses RLS) ever write to this
-- table -- there is deliberately no INSERT/UPDATE/DELETE policy for
-- `authenticated` below, only SELECT.
create table public.organization_billing (
  organization_id bigint primary key references public.organizations (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  -- Matches Stripe's own Subscription.status enum exactly (including
  -- 'paused', from Stripe's pause-collection feature) so the webhook
  -- handler's UPDATE can never fail on a status Stripe itself considers
  -- valid. A status Stripe adds after this migration is the one gap this
  -- can't cover in advance -- would surface as a loud webhook failure
  -- (Stripe retries a non-2xx response), not a silent one.
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_billing enable row level security;

-- organization_billing: members can read their own org's billing state
-- (the dashboard billing page needs this); no write policy for anyone but
-- service_role, which bypasses RLS entirely.
create policy organization_billing_select on public.organization_billing
  for select
  to authenticated
  using (private.is_org_member(organization_id));

-- Every new organization starts on a 14-day trial, no card required --
-- matches create_organization_atomic's own "no INSERT policy for
-- authenticated" model: this fires as part of that SECURITY DEFINER
-- function's own transaction (or the admin client's, for any other org
-- creation path), never directly from client code.
create or replace function private.provision_organization_trial()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.organization_billing (organization_id, status, trial_ends_at)
  values (new.id, 'trialing', now() + interval '14 days');
  return new;
end;
$$;

create trigger organizations_after_insert_provision_trial
  after insert on public.organizations
  for each row execute function private.provision_organization_trial();

-- Idempotency ledger for the Stripe webhook handler -- Stripe retries
-- delivery on anything but a 2xx response, and can also send the same
-- event more than once even without a retry (documented at-least-once
-- delivery). The handler inserts the event id here inside the same
-- transaction as its own state change; a duplicate delivery hits the
-- primary key and is a no-op rather than double-applying the event. No
-- RLS policies at all (not even SELECT) -- only the webhook route, using
-- the admin client, ever touches this table.
create table public.stripe_webhook_events (
  id text primary key,
  created_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
