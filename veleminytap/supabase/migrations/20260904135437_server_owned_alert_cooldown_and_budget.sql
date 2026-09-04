-- Round 2 finding R2-08: negative-feedback-alert.ts's cooldown claim
-- (an UPDATE against nfc_cards.last_negative_alert_at, guarded only by
-- RLS's row-level nfc_cards_update policy) is a plain column on a table
-- org members can already UPDATE for legitimate reasons (renaming a card,
-- activating/deactivating it). RLS is row-level, not column-level (the
-- same class of gap findings #3/#4 already fixed for other columns on
-- feedback/nfc_cards) -- confirmed empirically: a real authenticated
-- member's own session successfully reset last_negative_alert_at to NULL
-- via a direct UPDATE, and separately, set notification_email to an
-- arbitrary external address with zero verification. Combined with the
-- public (unauthenticated) submission endpoint and per-card rate limiting
-- that does nothing to bound TOTAL volume across an org's cards (the
-- reviewer's own framing: "creating more cards does not create unlimited
-- email capacity"), this is a real spam-relay vector: a malicious tenant
-- could point notification_email at an arbitrary third party, reset the
-- cooldown at will, and fan qualifying submissions out across as many
-- cards as they create to drive real emails through this app's verified
-- sending domain at volume.
--
-- Fixed in two parts:
--   1. last_negative_alert_at becomes genuinely server-owned via a trigger
--      that rejects any change to it unless a transaction-local flag
--      (app.allow_cooldown_update) is set, which only
--      claim_negative_alert_send() below ever sets. Round-3 finding R3-05:
--      that trigger is installed by a SEPARATE, LATER migration
--      (20260904194100_enforce_alert_cooldown_trigger.sql), not this one --
--      see that file's comment for the expand/deploy/enforce rollout
--      reasoning. This migration only builds the infrastructure the
--      trigger will rely on (the RPC, the log table); it does not yet
--      enforce anything against a direct UPDATE.
--   2. An organization-wide hourly budget, independent of the per-card
--      cooldown: private.alert_email_log is an append-only-by-outcome
--      record of every alert attempt, and claim_negative_alert_send()
--      refuses to claim (and therefore never sends) once an organization
--      has hit the budget in the trailing hour, regardless of how many
--      different cards the qualifying submissions came from.
--
-- Round-3 finding R3-02: the budget check above counted rows and compared
-- to the budget, then locked and updated only the ONE card row this call
-- concerns -- never anything organization-scoped. Two concurrent calls for
-- TWO DIFFERENT cards in the same org never contend on any shared lock
-- (each locks a different nfc_cards row), so both can read the same
-- "count < budget" snapshot and both pass, overshooting the budget by as
-- many concurrent callers as there are distinct cards to submit against.
-- Confirmed: with the budget set to 1 and zero prior sends, two concurrent
-- claims for two different cards in the same org both returned a claim.
-- Fixed with a transaction-scoped advisory lock keyed on the organization
-- id, taken before the count-check -- a second concurrent call for the
-- same org now blocks until the first's transaction commits or rolls
-- back, and re-reads the now-current count once unblocked.
--
-- Round-3 finding R3-06: the previous version inserted the log row as an
-- unconditional record of an alert "actually sent" the moment the
-- cooldown/budget checks passed -- before the caller had even looked up a
-- recipient, let alone called Resend. A missing notification_email
-- config, an org with no owner/admin/manager members, or a genuine Resend
-- API failure all consumed the card's cooldown and a slot in the org-wide
-- budget for an email that was never sent, and the row was
-- indistinguishable from a real delivery in both the schema and this
-- app's documentation. Rows are now attempts/reservations with an
-- explicit status ('reserved' -> 'delivered' or 'failed', set by
-- finalize_negative_alert_send below), not sends. The org-wide budget
-- counts 'reserved'+'delivered' rows within the trailing hour (an
-- in-flight attempt must still count while unresolved, or two
-- closely-spaced attempts could both slip past a budget check that only
-- counted confirmed deliveries) but excludes 'failed' ones once known --
-- a transient delivery failure must not permanently consume real capacity
-- the org never actually used. A reservation that's never finalized
-- (e.g. the process crashes between claiming and sending) still counts
-- until it ages out of the same 1-hour window used everywhere else here
-- -- an accepted, bounded worst case, not an unbounded leak. This
-- deliberately does NOT also release the per-card 5-minute cooldown on a
-- failed attempt: the org-wide budget is the actual scarce resource this
-- addresses (R3-06 called it "alert capacity"), and loosening the
-- per-card cooldown on failure would reopen a narrower version of the
-- same tenant-reset risk R2-08 already closed, for a much smaller benefit
-- (5 minutes) than the complexity would cost.
--
-- "Address verification of arbitrary notification recipients" (a separate
-- reviewer sub-finding, R2-08/R3-03) is deliberately NOT addressed here --
-- see DECISIONS.md.

create table private.alert_email_log (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  nfc_card_id bigint not null references public.nfc_cards (id) on delete cascade,
  status text not null default 'reserved' check (status in ('reserved', 'delivered', 'failed')),
  reserved_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz
);

-- SECURITY INVOKER means claim_negative_alert_send/finalize_negative_alert_send
-- run as their actual caller (service_role) -- RLS bypass (bypassrls) is a
-- separate privilege from schema/table GRANTs, so service_role still needs
-- its own explicit access to read/write this table, the same as any other
-- role would (a real bug hit and fixed while building this: service_role
-- initially had bypassrls but no grant on this schema/table at all, and
-- failed with "permission denied for schema private").
grant usage on schema private to service_role;
grant select, insert, update on private.alert_email_log to service_role;

create index alert_email_log_org_reserved_at_idx on private.alert_email_log (organization_id, reserved_at);

-- SECURITY INVOKER: the only caller is the admin (service_role) client,
-- which already bypasses RLS at the connection-role level -- same
-- reasoning as submit_feedback_atomic. Returns the new log row's id (to be
-- passed to finalize_negative_alert_send once the caller knows the actual
-- outcome), or null if nothing was claimed.
create or replace function public.claim_negative_alert_send(
  p_nfc_card_id bigint,
  p_cooldown_minutes int default 5,
  p_org_hourly_budget int default 30
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_recent_org_count integer;
  v_claimed_id bigint;
  v_log_id bigint;
begin
  select organization_id into v_org_id from public.nfc_cards where id = p_nfc_card_id;
  if v_org_id is null then
    return null;
  end if;

  -- R3-02: serialize per organization, before the budget count below, so
  -- a second concurrent call for the same org can never read a
  -- pre-reservation snapshot. Namespaced with a distinct string prefix so
  -- this can never collide with create_organization_atomic's per-user
  -- advisory lock, which hashes a different kind of key entirely (a UUID
  -- string, not an organization id) -- an accidental collision there would
  -- only cause a spurious extra wait between unrelated operations, not an
  -- incorrect result, but there is no reason to risk even that.
  perform pg_advisory_xact_lock(hashtext('claim_negative_alert_send:' || v_org_id::text)::bigint);

  select count(*) into v_recent_org_count
  from private.alert_email_log
  where organization_id = v_org_id
    and status <> 'failed'
    and reserved_at > now() - interval '1 hour';

  if v_recent_org_count >= p_org_hourly_budget then
    return null;
  end if;

  perform set_config('app.allow_cooldown_update', 'true', true);
  update public.nfc_cards
  set last_negative_alert_at = now()
  where id = p_nfc_card_id
    and (
      last_negative_alert_at is null
      or last_negative_alert_at < now() - (p_cooldown_minutes || ' minutes')::interval
    )
  returning id into v_claimed_id;

  if v_claimed_id is null then
    return null;
  end if;

  insert into private.alert_email_log (organization_id, nfc_card_id, status)
  values (v_org_id, p_nfc_card_id, 'reserved')
  returning id into v_log_id;

  return v_log_id;
end;
$$;

revoke execute on function public.claim_negative_alert_send(bigint, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_negative_alert_send(bigint, int, int)
  to service_role;

-- R3-06: reports the real outcome of the one attempt a prior
-- claim_negative_alert_send() call authorized. Called exactly once per
-- successful claim, from a `finally` block in
-- features/notifications/negative-feedback-alert.ts, so every reservation
-- resolves to 'delivered' or 'failed' whenever the process gets a chance
-- to run that block at all. `where status = 'reserved'` makes this
-- idempotent against an accidental duplicate call (a second call is a
-- silent no-op, not an error or a double-transition).
create or replace function public.finalize_negative_alert_send(
  p_log_id bigint,
  p_delivered boolean
)
returns void
language sql
security invoker
set search_path = ''
as $$
  update private.alert_email_log
  set status = case when p_delivered then 'delivered' else 'failed' end,
      delivered_at = case when p_delivered then now() else delivered_at end,
      failed_at = case when p_delivered then failed_at else now() end
  where id = p_log_id
    and status = 'reserved';
$$;

revoke execute on function public.finalize_negative_alert_send(bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.finalize_negative_alert_send(bigint, boolean)
  to service_role;
