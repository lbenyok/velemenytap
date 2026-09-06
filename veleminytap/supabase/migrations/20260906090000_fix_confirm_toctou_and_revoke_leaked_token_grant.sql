-- Round-6 findings R6-01 and R6-05. Both fix functions that are ALREADY
-- applied to production (migration 20260904194400_notification_email_
-- verification.sql) -- this is a corrective migration, not an edit to that
-- file, per this project's own rule against rewriting a production-applied
-- migration.
--
-- R6-01 (HIGH): request_notification_email_change(bigint, text, int) --
-- the currently-deployed, 3-argument, round-3 version -- returns the raw
-- confirmation token directly to its caller, and is EXECUTE-granted to
-- `authenticated`. Nothing stops an organization member from calling this
-- RPC directly through their own authenticated Supabase client (bypassing
-- the settings Server Action, and the Resend email step, entirely) with an
-- arbitrary email address, reading the live token straight out of the RPC
-- response, and immediately visiting the public confirmation link with it
-- -- confirming an address without ever proving control of its inbox. This
-- is not a hypothetical: the existing e2e suite's own "requesting a new
-- address sets it as pending" test already demonstrates exactly this
-- direct-RPC-call, read-token-from-response pattern, which is the whole
-- attack. It defeats the entire point of round 3's confirmation flow.
--
-- Revoking `authenticated`'s EXECUTE grant here closes the live
-- vulnerability immediately and unconditionally, rather than leaving it
-- reachable for the length of a "safe" rollout window -- a rollout-
-- compatibility concern does not outweigh an open credential-disclosure
-- bug in the very code path being kept "compatible". A caller still on
-- old application code that tries to change the notification email during
-- the (typically brief) gap between this migration landing and the new
-- application code deploying gets a clean, loud "permission denied for
-- function" instead of either a confusing missing-function error or,
-- worse, continuing to work insecurely. See DECISIONS.md for the full
-- reasoning and the deliberate divergence from a strict zero-disruption
-- expand/deploy/contract sequence this represents.
--
-- The function body itself is deliberately left in place (not dropped) --
-- round-6 finding R6-03 -- so this migration alone cannot mint a NEW
-- signature conflict; a later cleanup migration, once the new 2-argument
-- request_notification_email_change (migration 20260905193325, edited in
-- place since it never reached production) has been live long enough that
-- nothing could still be calling the old one, will DROP this function
-- outright.
--
-- Wrapped defensively: an environment whose migration history diverges
-- from production's (e.g. this project's own isolated test project, whose
-- history is independently built up and does not necessarily retain every
-- production-applied object exactly) may not have this 3-argument
-- function at all -- `revoke` has no `if exists` form the way `drop` does,
-- so an unguarded revoke against a genuinely absent function would fail
-- the whole migration outright. The intent here (this grant must not
-- exist) already holds trivially if the function itself doesn't.
do $$
begin
  revoke execute on function public.request_notification_email_change(bigint, text, int) from authenticated;
exception
  when undefined_function then
    null;
end
$$;

-- R6-05 (MEDIUM): confirm_notification_email_change had a TOCTOU race --
-- it SELECTed the organization matching the supplied token's hash, then
-- separately UPDATEd that organization by id alone, with no re-check of
-- the token. A concurrent request_notification_email_change() call for
-- the SAME organization, landing between those two statements, replaces
-- the pending email/token-hash/expiry with a brand new candidate -- and
-- the UPDATE, keyed only on id, then blindly promotes THAT new pending
-- address using the OLD (different) token's authority. The old token was
-- never valid for the new address; nothing about it proves the confirmer
-- controls the new address's inbox.
--
-- Fixed by collapsing the two statements into one atomic UPDATE whose
-- WHERE clause re-checks the token hash, the expiry, and that a pending
-- address still exists, using RETURNING to learn whether it matched
-- anything -- there is no longer a separate "read" step for a concurrent
-- write to land in between.
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
  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email = notification_email_pending,
      notification_email_pending = null,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where notification_email_pending_token_hash = v_token_hash
    and notification_email_pending_expires_at > now()
    and notification_email_pending is not null
  returning id into v_org_id;

  return v_org_id;
end;
$$;
