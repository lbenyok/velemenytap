-- Second independent review (2026-09-07), findings 2 and 3/4: the billing
-- webhook and Checkout-lease design both had real, reproduced concurrency
-- gaps that the first review-response round's fixes did not close.
--
-- FINDING 3/4 -- webhook reconciliation must be organization/customer-wide
-- and fenced against out-of-order writers, not per-subscription and
-- unfenced:
--
--   Canonical retrieval (stripe.subscriptions.retrieve()) is authoritative
--   only for the ONE subscription it fetches -- it says nothing about
--   whether that subscription is still the organization's CURRENT one. A
--   canceled sub_old, superseded by a genuinely newer sub_new, still
--   produces a real, valid, signed webhook event whenever Stripe retries
--   or an operator manually redelivers it -- syncSubscription previously
--   retrieved exactly that stale subscription and wrote it, unconditionally
--   overwriting sub_new's live state with sub_old's dead one. Fixed by
--   never trusting a single retrieved subscription as this organization's
--   truth: the webhook now lists EVERY subscription for the event's
--   Stripe Customer and picks whichever one should currently govern
--   entitlement (see app/api/webhooks/stripe/route.ts's
--   pickCurrentSubscription), so an event naming an old subscription still
--   causes a fresh, complete re-derivation of the organization's real
--   current state, never a blind overwrite with what that one event
--   happened to carry.
--
--   That still leaves a genuine write-write race: two webhook deliveries
--   for the same organization, processed concurrently by two different
--   serverless invocations, can each retrieve/list Stripe state, then
--   race to write -- the OLDER request's write landing AFTER the newer
--   one's, silently reverting it, with both requests still returning
--   HTTP 200. billing_sync_seq is a per-organization fencing token: each
--   sync claims the NEXT value (claim_billing_sync, an atomic single-row
--   UPDATE, called before any Stripe network call -- no database
--   transaction ever spans one) and its own final write is conditioned on
--   still holding that exact value. A request that started earlier but
--   finishes later than another has a lower seq by the time it writes;
--   its UPDATE ... WHERE billing_sync_seq = <its own seq> matches zero
--   rows once a newer request has already advanced the counter, and the
--   stale request correctly stands down instead of overwriting the newer
--   result -- see the corrected syncSubscription for exactly how this is
--   used.
--
-- FINDING 2 -- the Checkout lease needed to be a durable, owned attempt,
-- not a bare (session id, expiry) pair with no compare-and-swap:
--
--   checkout_attempt_id is an opaque, immutable token minted once per
--   genuinely new attempt (claim_checkout_attempt) and required by every
--   later write against that attempt (record_checkout_session,
--   release_checkout_attempt) -- a caller holding a superseded attempt id
--   can never modify a newer claim, because its own UPDATE's WHERE clause
--   requires an exact match. Every lease decision uses clock_timestamp()
--   INSIDE these functions, not a timestamp computed by the Node caller,
--   so a skewed application-server clock can never affect who legitimately
--   owns the row. checkout_attempt_interval/checkout_attempt_price_id/
--   checkout_attempt_mode record exactly what plan this attempt is FOR, so
--   a stored session is only ever reused when it still matches what's
--   actually being requested -- see features/billing/actions.ts for the
--   full reconciliation flow, including why a superseded attempt's own
--   (now-orphaned) session id is still returned and checked against Stripe
--   before ever creating a second one.
--
-- pending_checkout_session_id (added by 20260907190000) is kept -- it
-- still means exactly what it always did, "the Stripe Checkout Session
-- this attempt created, if any" -- but pending_checkout_expires_at is
-- replaced by checkout_attempt_expires_at, which now governs the CLAIM
-- itself, not just the session's own reuse window; a single lease field
-- serving both purposes (as before) could not distinguish "still claiming,
-- about to call Stripe" from "a real session already exists" the way the
-- two-phase design here requires.
alter table public.organization_billing
  add column billing_sync_seq bigint not null default 0,
  add column checkout_attempt_id text,
  add column checkout_attempt_interval text,
  add column checkout_attempt_price_id text,
  add column checkout_attempt_mode text,
  add column checkout_attempt_expires_at timestamptz;

alter table public.organization_billing
  drop column pending_checkout_expires_at;

alter table public.organization_billing
  add constraint organization_billing_checkout_attempt_interval_check
  check (checkout_attempt_interval is null or checkout_attempt_interval in ('monthly', 'yearly')),
  add constraint organization_billing_checkout_attempt_mode_check
  check (checkout_attempt_mode is null or checkout_attempt_mode = 'subscription');

-- Atomically advances this organization's reconciliation fencing token and
-- returns the new value -- the only thing a caller needs to hold before
-- doing any Stripe network call, and to condition its own eventual write
-- on. A single-statement UPDATE is its own row-level lock; two concurrent
-- callers for the same organization are naturally serialized by Postgres
-- and receive strictly increasing, distinct values.
create or replace function public.claim_billing_sync(p_organization_id bigint)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set billing_sync_seq = billing_sync_seq + 1
  where organization_id = p_organization_id
  returning billing_sync_seq;
$$;

revoke execute on function public.claim_billing_sync(bigint) from public, anon, authenticated;
grant execute on function public.claim_billing_sync(bigint) to service_role;

-- Claims ownership of the organization's checkout-attempt slot: reuses a
-- still-live existing attempt's identity (never mints a second live one),
-- or mints a fresh opaque attempt id once the previous one's lease has
-- expired. The row lock (`for update`) serializes concurrent claims for
-- the SAME organization, so two callers can never both believe they won.
--
-- Returning a superseded attempt's own pending_checkout_session_id/
-- interval/price/mode ALONGSIDE a freshly-minted attempt id (rather than
-- discarding them) is deliberate: a completed Stripe Checkout Session
-- must still be reconciled even after the local lease around it has
-- expired (Finding 2's explicit "completed session after 24 hours" case)
-- -- the caller checks Stripe for that orphaned session before ever
-- creating a new one, and only if it's genuinely unusable does it proceed
-- with the new attempt this call already claimed.
create or replace function public.claim_checkout_attempt(
  p_organization_id bigint,
  p_interval text,
  p_price_id text,
  p_mode text,
  p_claim_seconds int default 150
)
returns table (
  attempt_id text,
  is_new_attempt boolean,
  existing_session_id text,
  existing_interval text,
  existing_price_id text,
  existing_mode text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.organization_billing%rowtype;
  v_new_attempt_id text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  if v_row.checkout_attempt_id is not null
     and v_row.checkout_attempt_expires_at is not null
     and v_row.checkout_attempt_expires_at > v_now
  then
    return query select
      v_row.checkout_attempt_id, false,
      v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
      v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode;
    return;
  end if;

  v_new_attempt_id := encode(extensions.gen_random_bytes(16), 'hex');

  update public.organization_billing
  set checkout_attempt_id = v_new_attempt_id,
      checkout_attempt_interval = p_interval,
      checkout_attempt_price_id = p_price_id,
      checkout_attempt_mode = p_mode,
      checkout_attempt_expires_at = v_now + (p_claim_seconds || ' seconds')::interval
  where organization_id = p_organization_id;

  return query select
    v_new_attempt_id, true,
    v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
    v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode;
end;
$$;

revoke execute on function public.claim_checkout_attempt(bigint, text, text, text, int) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(bigint, text, text, text, int) to service_role;

-- Persists a real Stripe Checkout Session against the attempt that created
-- it, extending its lease to the session's own real lifetime -- but ONLY
-- if p_attempt_id still owns the row. A delayed caller holding a
-- superseded attempt id (its own claim having since expired and been
-- replaced by a newer one) matches zero rows here and must not overwrite
-- the newer attempt's state; the caller inspects this function's boolean
-- result and fails closed rather than assuming success.
create or replace function public.record_checkout_session(
  p_organization_id bigint,
  p_attempt_id text,
  p_session_id text,
  p_lease_seconds int default 86400
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set pending_checkout_session_id = p_session_id,
      checkout_attempt_expires_at = clock_timestamp() + (p_lease_seconds || ' seconds')::interval
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
  returning true;
$$;

revoke execute on function public.record_checkout_session(bigint, text, text, int) from public, anon, authenticated;
grant execute on function public.record_checkout_session(bigint, text, text, int) to service_role;

-- Releases an attempt (a stale/mismatched-plan Stripe session, or one
-- Stripe reports 'expired') so a fresh claim can be taken immediately,
-- rather than waiting out the rest of its lease. CAS'd on p_attempt_id for
-- the identical reason as record_checkout_session.
create or replace function public.release_checkout_attempt(
  p_organization_id bigint,
  p_attempt_id text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set checkout_attempt_id = null,
      checkout_attempt_interval = null,
      checkout_attempt_price_id = null,
      checkout_attempt_mode = null,
      checkout_attempt_expires_at = null,
      pending_checkout_session_id = null
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
  returning true;
$$;

revoke execute on function public.release_checkout_attempt(bigint, text) from public, anon, authenticated;
grant execute on function public.release_checkout_attempt(bigint, text) to service_role;
