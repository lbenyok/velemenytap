-- Fifth review round (2026-09-08) -- integrating an independent parallel
-- implementation's checkout-identity model into this project's own
-- attempt/lease schema. Migrations up through 20260907240000 have already
-- been applied to the isolated test project, so this is a FORWARD
-- migration, never an edit of an applied one (the same discipline as
-- 20260907210000/230000/240000's own headers).
--
-- Three real gaps this closes, all of them about what happens when a
-- Checkout operation is interrupted mid-flight:
--
-- GAP 1 -- attempt identity was destroyed by lease expiry. A single
-- column, checkout_attempt_expires_at, meant BOTH "this request currently
-- owns the slot" and "this attempt exists at all." So a request that
-- crashed (or merely ran slow) after calling Stripe but before recording
-- its Session lost the attempt id entirely: the next request minted a
-- FRESH checkout_attempt_id, and therefore a fresh
-- `checkout:attempt-<id>` idempotency key, and Stripe -- having never
-- seen that key -- created a genuine SECOND Checkout Session for the same
-- organization. Fixed by splitting the two concepts: checkout_attempt_id
-- is the durable identity of "an attempt to subscribe" and survives lease
-- expiry, while checkout_owner_token + checkout_attempt_expires_at are
-- the short-lived OPERATION lease over it. A later request takes over the
-- same attempt id, and therefore replays the same idempotency key, so
-- Stripe returns the SAME Session rather than creating another.
--
-- GAP 2 -- a replayed idempotency key requires byte-identical parameters.
-- Stripe rejects (not deduplicates) a retry whose parameters differ from
-- the original call sharing that key. Rebuilding the request in
-- application code on every attempt made that guarantee depend on nothing
-- in the request ever changing between attempts -- including
-- NEXT_PUBLIC_SITE_URL, whichever price id an env var resolves to, and
-- the organization's own row. checkout_request is the IMMUTABLE snapshot
-- of exactly what was sent the first time; a takeover replays that stored
-- object verbatim rather than re-deriving it. It is written once, when the
-- attempt is created, and never mutated afterward -- only cleared when the
-- attempt itself is released.
--
-- GAP 3 -- an idempotency key is only useful while Stripe still remembers
-- it. Stripe documents roughly 24 hours of retention, not a permanent
-- guarantee, so replaying a key older than that is NOT deduplicated and
-- would create a second Session. checkout_created_at records when the
-- attempt (and therefore its key) was minted, and the claim reports
-- retry_safe = "still inside a conservative 23-hour window." Outside it,
-- the caller must reconcile the recorded Session against Stripe and start
-- a genuinely new attempt instead of blindly replaying.
--
-- The operation-lease/attempt split additionally makes "the Session was
-- created but this request died before recording it" recoverable at all:
-- finish_checkout_operation releases only the LEASE, deliberately keeping
-- the attempt (its id, its request, its recorded session) so a later
-- request can find and reconcile it. release_checkout_attempt -- the only
-- thing that discards the identity -- is called exclusively once a
-- terminal Stripe state has actually been confirmed.
alter table public.organization_billing
  add column checkout_request jsonb,
  add column checkout_created_at timestamptz,
  add column checkout_owner_token text;

-- Signatures change (an immutable request goes in; an owner token comes
-- out), so these are drops and creates rather than create-or-replace. Only
-- service_role can execute any of them, and features/billing/actions.ts --
-- their sole caller -- is updated in the same change.
drop function if exists public.claim_checkout_attempt(bigint, text, text, text, int);
drop function if exists public.renew_checkout_attempt(bigint, text, int);
drop function if exists public.record_checkout_session(bigint, text, text, int);
drop function if exists public.release_checkout_attempt(bigint, text);

-- Claims the OPERATION LEASE over this organization's checkout attempt,
-- creating the attempt itself only if none exists yet.
--
-- p_request is validated here, not merely trusted: an immutable snapshot
-- that could name a different price, a different customer, or a different
-- organization than the claim it is stored under would defeat the point of
-- storing it. The checks below are the database's own guarantee that the
-- stored request can only ever be a faithful description of THIS
-- organization's claim, whatever application code passes in.
--
-- Returns owner_token = null when another operation currently holds a live
-- lease -- the caller must stand down rather than race it. Otherwise
-- returns the attempt's durable identity, the stored request to replay,
-- whichever Session that attempt has already recorded (if any), and
-- whether the attempt's idempotency key is still inside Stripe's own
-- retention window.
create function public.claim_checkout_attempt(
  p_organization_id bigint,
  p_interval text,
  p_price_id text,
  p_request jsonb,
  p_claim_seconds int default 150
)
returns table (
  attempt_id text,
  owner_token text,
  is_new_attempt boolean,
  existing_session_id text,
  existing_interval text,
  existing_price_id text,
  existing_mode text,
  request jsonb,
  retry_safe boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.organization_billing%rowtype;
  v_owner text;
  v_is_new boolean := false;
  v_prev_session text;
begin
  select * into v_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_billing has no row for organization %', p_organization_id using errcode = 'VT301';
  end if;

  -- clock_timestamp() is read AFTER the row lock is granted, never before
  -- waiting for it -- a caller that queued behind a long-held lock must
  -- not evaluate expiry against a timestamp taken before its wait.
  v_now := clock_timestamp();

  if p_interval is null or p_interval not in ('monthly', 'yearly')
     or coalesce(p_price_id, '') = ''
     or v_row.stripe_customer_id is null
     or p_request is null
     or p_request ->> 'mode' is distinct from 'subscription'
     or p_request ->> 'customer' is distinct from v_row.stripe_customer_id
     or p_request #>> '{line_items,0,price}' is distinct from p_price_id
     or p_request ->> 'client_reference_id' is distinct from p_organization_id::text
  then
    raise exception 'Invalid checkout request for organization %', p_organization_id using errcode = 'VT302';
  end if;

  if v_row.checkout_owner_token is not null
     and v_row.checkout_attempt_expires_at is not null
     and v_row.checkout_attempt_expires_at > v_now
  then
    return query select
      v_row.checkout_attempt_id, null::text, false,
      v_row.pending_checkout_session_id, v_row.checkout_attempt_interval,
      v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode,
      v_row.checkout_request, false;
    return;
  end if;

  v_owner := encode(extensions.gen_random_bytes(16), 'hex');
  v_prev_session := v_row.pending_checkout_session_id;

  -- A legacy attempt from before this migration has no stored request and
  -- therefore nothing safe to replay: its identity is discarded and a new
  -- attempt minted, unbound from whatever Session the old attempt had
  -- recorded. That Session id is still RETURNED (v_prev_session) so the
  -- caller reconciles it against Stripe before creating anything new --
  -- losing the pointer to a real, possibly-completed Session is the one
  -- outcome this whole design exists to prevent.
  if v_row.checkout_attempt_id is null or v_row.checkout_request is null then
    update public.organization_billing
    set checkout_attempt_id = encode(extensions.gen_random_bytes(16), 'hex'),
        checkout_attempt_interval = p_interval,
        checkout_attempt_price_id = p_price_id,
        checkout_attempt_mode = 'subscription',
        checkout_request = p_request,
        checkout_created_at = v_now,
        pending_checkout_session_id = null
    where organization_id = p_organization_id;
    v_is_new := true;
  end if;

  update public.organization_billing
  set checkout_owner_token = v_owner,
      checkout_attempt_expires_at = v_now + make_interval(secs => greatest(1, least(600, p_claim_seconds)))
  where organization_id = p_organization_id
  returning * into v_row;

  return query select
    v_row.checkout_attempt_id, v_owner, v_is_new,
    v_prev_session, v_row.checkout_attempt_interval,
    v_row.checkout_attempt_price_id, v_row.checkout_attempt_mode,
    v_row.checkout_request,
    coalesce(v_row.checkout_created_at > v_now - interval '23 hours', false);
end;
$$;

revoke execute on function public.claim_checkout_attempt(bigint, text, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(bigint, text, text, jsonb, int) to service_role;

-- Proves the caller still holds the operation lease and pushes its expiry
-- out, at a checkpoint the caller controls (immediately before the slowest
-- remaining Stripe call). Both the attempt identity and the operation
-- token must still match -- holding a superseded token can never extend
-- somebody else's lease.
create function public.renew_checkout_attempt(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text,
  p_claim_seconds int default 150
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Take the row lock EXPLICITLY before the timed UPDATE below. Without
  -- this, Postgres evaluates the UPDATE's own `expires_at >
  -- clock_timestamp()` qual during the scan -- i.e. BEFORE waiting behind
  -- another transaction's lock -- and then applies the update once the
  -- wait ends, by which time the lease may have expired. (An UPDATE only
  -- re-checks its qual after a wait when the blocking transaction
  -- actually modified the row; a plain SELECT ... FOR UPDATE holder
  -- leaves the tuple unchanged, so nothing is re-evaluated.) Locking
  -- first collapses that window: everything after this statement is
  -- evaluated with the lock already held. Proven by
  -- scripts/verify-local-database.mjs, which blocks a real second
  -- connection behind a real lock and lets the lease lapse during the
  -- wait -- and which caught exactly this bug in an earlier version of
  -- this migration.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set checkout_attempt_expires_at =
        clock_timestamp() + make_interval(secs => greatest(1, least(600, p_claim_seconds)))
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
    and checkout_attempt_expires_at > clock_timestamp();

  return found;
end;
$$;

revoke execute on function public.renew_checkout_attempt(bigint, text, text, int) from public, anon, authenticated;
grant execute on function public.renew_checkout_attempt(bigint, text, text, int) to service_role;

-- Records the Stripe Session an attempt created. The caller invokes this
-- IMMEDIATELY after stripe.checkout.sessions.create() returns and BEFORE
-- validating anything about the returned Session -- a Session that exists
-- at Stripe but was never written down here is invisible to every later
-- attempt, which is precisely how a duplicate subscription gets created.
-- Validation can safely happen after the id is durable; creation cannot be
-- undone by discovering a problem afterward.
--
-- `pending_checkout_session_id is null or = p_session_id` keeps this
-- idempotent: replaying the same attempt's own key returns the same
-- Session id, and re-recording it must succeed rather than look like a
-- conflict. A DIFFERENT session id against an attempt that already has
-- one is refused -- that would mean the identity guarantee above had
-- already been violated somewhere upstream.
create function public.record_checkout_session(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text,
  p_session_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Same lock-then-check discipline as renew_checkout_attempt above, for
  -- the same reason: this UPDATE's expiry qual must be evaluated after any
  -- wait for the row lock, never before it.
  perform 1 from public.organization_billing
  where organization_id = p_organization_id
  for update;

  update public.organization_billing
  set pending_checkout_session_id = p_session_id
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
    and checkout_attempt_expires_at > clock_timestamp()
    and (pending_checkout_session_id is null or pending_checkout_session_id = p_session_id);

  return found;
end;
$$;

revoke execute on function public.record_checkout_session(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.record_checkout_session(bigint, text, text, text) to service_role;

-- Ends the OPERATION, keeping the ATTEMPT. Called on the success path,
-- once the Session's URL has been handed back to the customer: the
-- customer may still be on Stripe's hosted page, so the attempt (its id,
-- its immutable request, its recorded session) must stay -- but no
-- operation is in flight any more, so a later request may take the lease
-- over without waiting out a full expiry.
create function public.finish_checkout_operation(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.organization_billing
  set checkout_owner_token = null,
      checkout_attempt_expires_at = null
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
  returning true;
$$;

revoke execute on function public.finish_checkout_operation(bigint, text, text) from public, anon, authenticated;
grant execute on function public.finish_checkout_operation(bigint, text, text) to service_role;

-- Discards the attempt identity entirely -- the immutable request, the
-- creation time, the recorded session, all of it. This is the ONLY
-- function that destroys the idempotency-key identity, so it is called
-- only once Stripe has actually confirmed the recorded Session is in a
-- terminal, unusable state (expired, or complete-but-unpaid), never merely
-- because a local operation gave up or timed out.
create function public.release_checkout_attempt(
  p_organization_id bigint,
  p_attempt_id text,
  p_owner_token text
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
      checkout_owner_token = null,
      checkout_request = null,
      checkout_created_at = null,
      pending_checkout_session_id = null
  where organization_id = p_organization_id
    and checkout_attempt_id = p_attempt_id
    and checkout_owner_token = p_owner_token
  returning true;
$$;

revoke execute on function public.release_checkout_attempt(bigint, text, text) from public, anon, authenticated;
grant execute on function public.release_checkout_attempt(bigint, text, text) to service_role;
