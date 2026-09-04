-- Round-3 finding R3-03: an organization's notification_email accepted any
-- syntactically-valid address with zero verification that the org
-- actually controls it. Round-2's R2-08 fix (server-owned cooldown, an
-- org-wide hourly budget) bounded the resulting spam-relay blast radius
-- but never addressed the underlying gap the reviewer flagged again this
-- round: a tenant could still point real, budget-limited alert traffic at
-- an arbitrary third party's inbox.
--
-- Fixed with a real confirmation flow, not another heuristic:
--   1. Setting a new notification email no longer writes it directly.
--      request_notification_email_change() stores it as PENDING, alongside
--      a hash of a randomly-generated, single-use, 24-hour-expiring token
--      -- returned once, in plaintext, to the caller (never stored in
--      plaintext) so the app can email it as a confirmation link.
--   2. confirm_notification_email_change() promotes the pending address to
--      the active notification_email ONLY when called with a token whose
--      hash matches a non-expired pending request.
--   3. Until confirmed, notification_email (the address alerts actually
--      go to) is untouched -- features/notifications/negative-feedback-alert.ts
--      already falls back to emailing every owner/admin/manager member
--      when notification_email is null, so "alerts go only to verified
--      organization-member addresses until confirmation" falls directly
--      out of that existing behavior, not new logic.
--   4. Requesting a new pending address while one is already pending
--      overwrites it outright (new token, new expiry) -- the old token's
--      hash no longer matches anything, so it silently stops working;
--      there is deliberately no need to track a history of abandoned
--      requests.
--
-- clear_notification_email() (removing a configured address, reverting to
-- the member-fallback) needs no verification -- removing a recipient can't
-- be abused to send email anywhere, unlike adding one.
--
-- This migration adds the columns and both functions but deliberately
-- does NOT yet add the trigger that rejects a direct UPDATE to these
-- columns -- see 20260904194500_enforce_notification_email_change_trigger.sql's
-- comment for why that has to be a separate, later production step
-- (the same expand/deploy/enforce reasoning as R3-05's alert-cooldown
-- trigger split): the currently-deployed production settings action still
-- performs a direct `update organizations set notification_email = ...`,
-- and installing the rejecting trigger before that code is replaced would
-- break every settings save that touches this field.
create extension if not exists pgcrypto with schema extensions;

alter table public.organizations
  add column notification_email_pending text,
  add column notification_email_pending_token_hash text,
  add column notification_email_pending_expires_at timestamptz;

-- Only relevant when re-applying this migration by hand during
-- development (e.g. against the isolated test project outside the normal
-- migration flow) after an earlier draft of this same file used a
-- 2-argument signature -- `create or replace` does not replace a function
-- across a different argument list, it adds a second overload. No-op on a
-- true first-ever application.
drop function if exists public.request_notification_email_change(bigint, text);

-- SECURITY DEFINER (like create_organization_atomic): must be callable
-- directly by the authenticated member's own session, and there is
-- deliberately no broader UPDATE policy that would let a member set these
-- specific columns themselves once the enforcement trigger (next
-- migration) exists. Explicit auth.uid() + membership check mirrors that
-- function's own mitigations for the DEFINER privilege.
create or replace function public.request_notification_email_change(
  p_organization_id bigint,
  p_email text,
  p_expires_in_minutes int default 1440
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_raw_token text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT201';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where organization_id = p_organization_id and user_id = v_user_id
  ) then
    raise exception 'not a member of this organization' using errcode = 'VT202';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  -- p_expires_in_minutes defaults to 24 hours but is overridable -- the
  -- same tunable-parameter pattern claim_negative_alert_send already uses
  -- (p_cooldown_minutes/p_org_hourly_budget) so tests can exercise the
  -- expiry boundary directly (a token whose expiry is already in the past
  -- the instant it's created) without waiting a real 24 hours or writing
  -- to a column the enforcement trigger deliberately blocks even the
  -- admin client from touching directly.
  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending = p_email,
      notification_email_pending_token_hash = encode(extensions.digest(v_raw_token, 'sha256'), 'hex'),
      notification_email_pending_expires_at = now() + (p_expires_in_minutes || ' minutes')::interval
  where id = p_organization_id;

  return v_raw_token;
end;
$$;

revoke execute on function public.request_notification_email_change(bigint, text, int) from public, anon, service_role;
grant execute on function public.request_notification_email_change(bigint, text, int) to authenticated;

create or replace function public.clear_notification_email(p_organization_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT201';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where organization_id = p_organization_id and user_id = v_user_id
  ) then
    raise exception 'not a member of this organization' using errcode = 'VT202';
  end if;

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email = null,
      notification_email_pending = null,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where id = p_organization_id;
end;
$$;

revoke execute on function public.clear_notification_email(bigint) from public, anon, service_role;
grant execute on function public.clear_notification_email(bigint) to authenticated;

-- SECURITY INVOKER, called via the admin client from an unauthenticated
-- confirmation route (app/api/notification-email/confirm/route.ts) -- the
-- same "public-facing operation through the admin client, narrowly scoped
-- RPC grant" pattern as submit_feedback_atomic and claim_negative_alert_send.
-- The token itself is the only credential checked; there's no auth.uid()
-- to check because whoever clicks the email link may not be signed in to
-- this app at all (a different browser/device than the one that requested
-- the change), same as this app's existing /auth/confirm flow.
create or replace function public.confirm_notification_email_change(p_token text)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_token_hash text := encode(extensions.digest(p_token, 'sha256'), 'hex');
begin
  select id into v_org_id
  from public.organizations
  where notification_email_pending_token_hash = v_token_hash
    and notification_email_pending_expires_at > now();

  if v_org_id is null then
    return null;
  end if;

  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email = notification_email_pending,
      notification_email_pending = null,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where id = v_org_id;

  return v_org_id;
end;
$$;

revoke execute on function public.confirm_notification_email_change(text) from public, anon, authenticated;
grant execute on function public.confirm_notification_email_change(text) to service_role;
