-- Round-3 finding R3-07, two independent gaps between what the migrations
-- actually did and what SECURITY.md/DATABASE_SCHEMA.md claimed:
--
-- 1. 20260904130921_tenant_scoped_analytics_aggregation.sql revoked EXECUTE
--    on both analytics functions from `public` and `anon`, but never from
--    `service_role`. This project's ALTER DEFAULT PRIVILEGES configuration
--    (the same one round-2 finding R2-07 found for submit_feedback_atomic/
--    create_organization_atomic) grants EXECUTE on every new public-schema
--    function to service_role independent of PUBLIC, so both analytics
--    functions have retained service_role EXECUTE this whole time despite
--    being documented as "authenticated only" -- the SECURITY.md/
--    DATABASE_SCHEMA.md role-allowlist tables never actually matched
--    pg_proc.proacl for these two. (get_feedback_period_analytics is
--    re-declared with the corrected allowlist directly in
--    20260904194200_validate_analytics_period_days.sql, since that
--    migration already replaces its signature for R3-04; this migration
--    covers get_feedback_overview_snapshot, whose signature is unchanged.)
--
-- 2. DATABASE_SCHEMA.md's own description of private.alert_email_log
--    claimed "RLS is enabled but no policies exist for anon/authenticated"
--    -- but no migration ever actually ran `enable row level security` on
--    it. In practice this was not a demonstrated tenant leak (the private
--    schema isn't exposed to PostgREST, and no anon/authenticated grant
--    exists on the table either way -- RLS being off changed nothing
--    reachable), but the schema must match what's documented rather than
--    relying on a second, independent control nobody actually verified
--    lines up with the claim.
revoke execute on function public.get_feedback_overview_snapshot(bigint) from service_role;

alter table private.alert_email_log enable row level security;
