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
--   1. last_negative_alert_at becomes genuinely server-owned: a trigger
--      rejects ANY change to it unless a transaction-local flag
--      (app.allow_cooldown_update) is set, which only
--      claim_negative_alert_send() below ever sets. This blocks a direct
--      UPDATE from any caller, including the admin client -- there is now
--      exactly one way to change this column, not "the admin client
--      happens to be the only caller that currently does."
--   2. An organization-wide hourly budget, independent of the per-card
--      cooldown: private.alert_email_log is an append-only record of every
--      alert actually sent, and claim_negative_alert_send() refuses to
--      claim (and therefore never sends) once an organization has hit the
--      budget in the trailing hour, regardless of how many different cards
--      the qualifying submissions came from.
--
-- "Address verification of arbitrary notification recipients" (the
-- reviewer's third sub-finding) is deliberately NOT addressed here --
-- see DECISIONS.md for the reasoning. The budget above bounds the blast
-- radius of an unverified recipient to a hard, low ceiling; a real
-- email-confirmation flow for notification_email is a separate feature
-- (a new route, new email copy, new pending-state UI) disproportionate to
-- bundle into this fix without its own design pass. Flagged as an
-- explicitly open risk in the round-2 review response, not silently
-- dropped.

create table private.alert_email_log (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  nfc_card_id bigint not null references public.nfc_cards (id) on delete cascade,
  sent_at timestamptz not null default now()
);

-- SECURITY INVOKER means claim_negative_alert_send runs as its actual
-- caller (service_role) -- RLS bypass (bypassrls) is a separate privilege
-- from schema/table GRANTs, so service_role still needs its own explicit
-- access to read/write this table, the same as any other role would.
grant usage on schema private to service_role;
grant select, insert on private.alert_email_log to service_role;

create index alert_email_log_org_sent_at_idx on private.alert_email_log (organization_id, sent_at);

create or replace function private.prevent_direct_cooldown_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_negative_alert_at is distinct from old.last_negative_alert_at
     and coalesce(current_setting('app.allow_cooldown_update', true), 'false') <> 'true'
  then
    raise exception 'last_negative_alert_at can only be changed by claim_negative_alert_send()'
      using errcode = 'VT004';
  end if;
  return new;
end;
$$;

create trigger nfc_cards_prevent_direct_cooldown_update
  before update on public.nfc_cards
  for each row execute function private.prevent_direct_cooldown_update();

-- SECURITY INVOKER: the only caller is the admin (service_role) client,
-- which already bypasses RLS at the connection-role level -- same
-- reasoning as submit_feedback_atomic. Triggers fire regardless of RLS
-- bypass status, which is exactly what makes the trigger above an actual
-- boundary rather than a no-op for this caller too.
create or replace function public.claim_negative_alert_send(
  p_nfc_card_id bigint,
  p_cooldown_minutes int default 5,
  p_org_hourly_budget int default 30
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_recent_org_count integer;
  v_claimed_id bigint;
begin
  select organization_id into v_org_id from public.nfc_cards where id = p_nfc_card_id;
  if v_org_id is null then
    return false;
  end if;

  -- Org-wide budget, independent of which card(s) the submissions came
  -- from -- checked before the per-card cooldown so a budget-exhausted org
  -- never even attempts (and can never race) the column update below.
  select count(*) into v_recent_org_count
  from private.alert_email_log
  where organization_id = v_org_id
    and sent_at > now() - interval '1 hour';

  if v_recent_org_count >= p_org_hourly_budget then
    return false;
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
    return false;
  end if;

  insert into private.alert_email_log (organization_id, nfc_card_id)
  values (v_org_id, p_nfc_card_id);

  return true;
end;
$$;

revoke execute on function public.claim_negative_alert_send(bigint, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_negative_alert_send(bigint, int, int)
  to service_role;
