-- Fourth independent review, Finding 4: private.billing_anomalies
-- (migration 20260907210000) is not exposed to PostgREST at all (private
-- schema, not in config.toml's exposed `schemas` list) -- the same
-- pattern as every other private-schema table in this project
-- (private.alert_email_log, private.notification_email_change_log). It
-- needs a dedicated RPC to write to it, the same way those do.
create or replace function public.record_billing_anomaly(
  p_organization_id bigint,
  p_kind text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into private.billing_anomalies (organization_id, kind, detail)
  values (p_organization_id, p_kind, p_detail);
$$;

revoke execute on function public.record_billing_anomaly(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_billing_anomaly(bigint, text, jsonb) to service_role;
