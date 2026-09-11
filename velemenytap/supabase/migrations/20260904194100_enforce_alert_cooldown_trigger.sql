-- Round-3 finding R3-05: this trigger used to be installed by the SAME
-- migration that introduced claim_negative_alert_send()
-- (20260904135437_server_owned_alert_cooldown_and_budget.sql). Applying
-- both to production in one step would create a real outage window: the
-- trigger rejects every direct UPDATE to nfc_cards.last_negative_alert_at,
-- but the currently-deployed application code (anything before this PR)
-- performs exactly that kind of direct UPDATE to claim the cooldown --
-- every negative-feedback alert would start failing with a database error
-- the instant this trigger exists, for as long as any pre-this-PR server
-- instance is still handling requests.
--
-- Split into two migrations specifically so production can follow a safe
-- expand/deploy/enforce sequence instead:
--   1. EXPAND -- apply 20260904135437 (the table, grants, and RPCs). Old
--      code keeps working exactly as before; nothing about its behavior
--      changes yet, since nothing rejects its direct UPDATE.
--   2. DEPLOY -- ship the application code in this PR, which calls
--      claim_negative_alert_send()/finalize_negative_alert_send() instead
--      of updating last_negative_alert_at directly. Once deployed and old
--      instances have drained, every code path that touches this column
--      goes through the RPC.
--   3. ENFORCE -- apply this migration. By now nothing legitimate updates
--      the column any other way, so the trigger has no old code left to
--      break.
--
-- See REVIEW_REQUEST.md's rollout plan for the exact production sequence
-- and how to verify step 2 has fully drained before applying this one.
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
