-- Round-3 finding R3-03, split for the same expand/deploy/enforce reason
-- as R3-05's alert-cooldown trigger: applying this at the same time as
-- 20260904194400_notification_email_verification.sql would break the
-- currently-deployed production settings action, which still performs a
-- direct `update organizations set notification_email = ...`. Apply this
-- migration only AFTER the application code in this PR (which uses
-- request_notification_email_change()/clear_notification_email() instead)
-- has been deployed and old instances have drained -- see
-- REVIEW_REQUEST.md's rollout plan for the exact sequence.
--
-- Without this trigger, RLS's existing row-level organizations_update
-- policy would let any org member write notification_email_pending_token_hash
-- to a hash of a token THEY chose (trivial to compute client-side), then
-- visit the confirmation link with that same token and "confirm" an
-- address without ever proving they control its inbox -- defeating the
-- entire point of this fix. RLS is row-level, not column-level, the same
-- gap already closed for feedback's content columns, nfc_cards.location_id,
-- and nfc_cards.last_negative_alert_at.
create or replace function private.prevent_direct_notification_email_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (
    new.notification_email is distinct from old.notification_email
    or new.notification_email_pending is distinct from old.notification_email_pending
    or new.notification_email_pending_token_hash is distinct from old.notification_email_pending_token_hash
    or new.notification_email_pending_expires_at is distinct from old.notification_email_pending_expires_at
  ) and coalesce(current_setting('app.allow_notification_email_change', true), 'false') <> 'true'
  then
    raise exception 'notification email fields can only be changed by request_notification_email_change(), clear_notification_email(), or confirm_notification_email_change()'
      using errcode = 'VT006';
  end if;
  return new;
end;
$$;

create trigger organizations_prevent_direct_notification_email_change
  before update on public.organizations
  for each row execute function private.prevent_direct_notification_email_change();
