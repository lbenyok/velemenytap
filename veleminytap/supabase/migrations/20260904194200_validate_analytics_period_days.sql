-- Round-3 finding R3-04: get_feedback_period_analytics passed
-- caller-controlled p_days directly into generate_series with no
-- validation. The dashboard UI only ever requests 7, 30, or 90 (see
-- app/dashboard/analytics/page.tsx's VALID_PERIODS), but the function is
-- EXECUTE-granted to `authenticated` (round-2 R2-02/R2-03/R2-04) and
-- callable directly by any authenticated user with an arbitrary p_days --
-- 100000, or a negative number, or zero -- forcing generate_series to
-- build a huge (or malformed) series and a correspondingly huge JSON
-- response for every call, with no cost to the caller beyond making the
-- request.
--
-- Fixed by validating p_days against an explicit allowlist (7/30/90 -- the
-- only values this app's own UI ever produces) as the FIRST thing this
-- function does, raising before generate_series or any table scan runs,
-- so an invalid call fails cheaply rather than constructing a series
-- first and rejecting late. p_since is also removed from the signature
-- entirely and derived from the now-validated p_days internally -- the
-- caller-supplied p_since was redundant with p_days in every legitimate
-- call anyway (features/analytics/queries.ts always computed it as "days
-- days back from today"), and a redundant, independently-trusted
-- parameter is one more thing a caller could set inconsistently with
-- p_days for no benefit.
create or replace function public.get_feedback_period_analytics(
  p_organization_id bigint,
  p_days int
)
returns jsonb
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_since timestamptz;
begin
  if p_days not in (7, 30, 90) then
    raise exception 'p_days must be one of 7, 30, or 90' using errcode = 'VT005';
  end if;

  v_since := (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
    - ((p_days - 1) || ' days')::interval;

  return (
    with base as (
      select f.*
      from public.feedback f
      where f.organization_id = p_organization_id
        and f.created_at >= v_since
    ),
    days as (
      select generate_series(
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - ((p_days - 1) || ' days')::interval,
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
        interval '1 day'
      )::date as day
    ),
    daily as (
      select
        (date_trunc('day', b.created_at at time zone 'utc'))::date as day,
        count(*) as count,
        avg(b.rating) as avg_rating
      from base b
      group by 1
    ),
    daily_series as (
      select d.day, coalesce(daily.count, 0) as count, daily.avg_rating
      from days d
      left join daily on daily.day = d.day
    ),
    by_location as (
      select
        l.id as location_id,
        l.name as location_name,
        count(b.id) as count,
        avg(b.rating) as avg_rating,
        (count(*) filter (where b.status = 'resolved'))::numeric / nullif(count(b.id), 0) * 100 as resolved_pct
      from base b
      join public.locations l on l.id = b.location_id
      group by l.id, l.name
    ),
    by_card as (
      select
        c.id as card_id,
        c.display_name as card_name,
        l.name as location_name,
        count(b.id) as count,
        avg(b.rating) as avg_rating
      from base b
      join public.nfc_cards c on c.id = b.nfc_card_id
      join public.locations l on l.id = c.location_id
      group by c.id, c.display_name, l.name
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'resolvedCount', (select count(*) filter (where status = 'resolved') from base),
      'ratingCounts', jsonb_build_object(
        '1', (select count(*) from base where rating = 1),
        '2', (select count(*) from base where rating = 2),
        '3', (select count(*) from base where rating = 3),
        '4', (select count(*) from base where rating = 4),
        '5', (select count(*) from base where rating = 5)
      ),
      'dailySeries', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', day, 'count', count, 'avgRating', avg_rating
        ) order by day asc), '[]'::jsonb)
        from daily_series
      ),
      'byLocation', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'locationId', location_id, 'locationName', location_name,
          'count', count, 'avgRating', avg_rating, 'resolvedPct', resolved_pct
        ) order by count desc), '[]'::jsonb)
        from by_location
      ),
      'byCard', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'cardId', card_id, 'cardName', card_name, 'locationName', location_name,
          'count', count, 'avgRating', avg_rating
        ) order by count desc), '[]'::jsonb)
        from by_card
      )
    )
  );
end;
$$;

-- Same allowlist as the original migration (round-3 R3-07 also revisits
-- this): authenticated only, never service_role/anon/public.
revoke execute on function public.get_feedback_period_analytics(bigint, int) from public, anon, service_role;
grant execute on function public.get_feedback_period_analytics(bigint, int) to authenticated;

-- The old (p_organization_id, p_since, p_days) overload is superseded by
-- the (p_organization_id, p_days) signature above -- drop it so a stale
-- client can't silently keep calling the old, unvalidated signature.
drop function if exists public.get_feedback_period_analytics(bigint, timestamptz, int);
