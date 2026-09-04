-- Round 2 finding R2-07: `revoke all on function ... from public;` (both
-- prior RPC-function migrations) does NOT actually remove anon/authenticated's
-- ability to call these functions on this project. Confirmed by direct
-- inspection of pg_proc.proacl and has_function_privilege(): both
-- submit_feedback_atomic and create_organization_atomic currently show
-- EXECUTE granted to anon, authenticated, AND service_role, none of it
-- routed through the PUBLIC pseudo-role at all.
--
-- Root cause: this project has ALTER DEFAULT PRIVILEGES configured (visible
-- in pg_default_acl for the public schema, defaclobjtype 'f') that grants
-- EXECUTE on every newly created function in `public` directly to anon,
-- authenticated, and service_role as independent, explicit ACL entries --
-- separate from, and unaffected by, a REVOKE that only targets PUBLIC.
-- REVOKE ... FROM PUBLIC only removes the privilege every role would
-- otherwise inherit *through* PUBLIC; it has no effect on a role's own
-- separately-granted entry.
--
-- Verified this is NOT a demonstrated RLS bypass for either function (see
-- REVIEW_REQUEST.md's finding table for the reproductions): calling
-- submit_feedback_atomic as anon always fails with "card not found" (its
-- SECURITY INVOKER body runs the nfc_cards lookup as anon, and RLS has no
-- anon SELECT policy on nfc_cards, so the lookup returns nothing regardless
-- of whether the public_id is real -- no data read, no insert possible,
-- since RLS also has no anon INSERT policy on feedback). Calling
-- create_organization_atomic as anon always fails with "not authenticated"
-- (its own auth.uid() IS NULL check, evaluated before any table access).
-- Both are still fixed here because relying on those *side effects*
-- happening to be safe is not the same as the grant itself being correct,
-- least-privilege, or robust to a future change in either function's body.
--
-- Fix: explicitly enumerate every role known to have (or be capable of
-- automatically acquiring, via the default-privilege behavior above) an
-- unwanted grant, rather than trusting a PUBLIC-only revoke.

revoke execute on function public.submit_feedback_atomic(uuid, smallint, text)
  from public, anon, authenticated;
grant execute on function public.submit_feedback_atomic(uuid, smallint, text)
  to service_role;

revoke execute on function public.create_organization_atomic(text)
  from public, anon, service_role;
grant execute on function public.create_organization_atomic(text)
  to authenticated;
