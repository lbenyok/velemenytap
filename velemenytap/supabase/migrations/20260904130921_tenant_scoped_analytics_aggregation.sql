-- Round 2 findings R2-02, R2-03, R2-04: features/analytics/fetch-all-rows.ts
-- fetched feedback rows page-by-page (via PostgREST .range(), i.e. SQL
-- LIMIT/OFFSET) up to a MAX_ROWS=5000 ceiling, then reduced them in JS.
-- Two distinct, confirmed problems with that approach, not one:
--
--   R2-02: 5000 is itself still a silent correctness ceiling. An
--   organization with more than 5000 feedback rows gets the exact same
--   silent truncation the original finding (#7) was about, just at a
--   higher threshold -- "prefer SQL aggregation" was the right call from
--   the start; page-by-page fetching only ever addressed the *specific*
--   1000-row PostgREST cap, not the underlying "correctness must not
--   depend on how many rows there are" requirement.
--
--   R2-03: OFFSET-based pagination is not consistent under concurrent
--   writes, and adding an `id` secondary sort key does not fix this --
--   ordering-among-ties and offset-stability-across-requests are different
--   properties. If a row is inserted between fetching page 1 (offset
--   0-999) and page 2 (offset 1000-1999), every row's effective offset
--   shifts by one for every row inserted ahead of it in sort order,
--   causing a row to be skipped or double-counted depending on where the
--   insert landed relative to the reader's position -- deterministically,
--   not just as a rare race.
--
-- Fixed by computing every statistic inside a single, tenant-scoped SQL
-- function per page (get_feedback_overview_snapshot,
-- get_feedback_period_analytics) instead of paginating raw rows into
-- Node at all. This resolves both R2-02 (a COUNT/AVG/GROUP BY over the
-- full matching set has no row-count ceiling to silently hit) and R2-03
-- (there is no multi-request pagination left to be inconsistent --
-- Postgres computes each of these as one query, which by definition sees
-- one consistent MVCC snapshot for its entire duration, however many times
-- the query plan re-scans the underlying CTE).
--
-- Consistency semantics, stated explicitly (R2-03 asked this to be
-- defined, not just implied): every number returned by ONE call to
-- get_feedback_overview_snapshot (or ONE call to
-- get_feedback_period_analytics) reflects exactly one, internally
-- consistent database snapshot -- the total, the daily series, the
-- per-location breakdown, and the per-card breakdown within a single
-- get_feedback_period_analytics call can never disagree with each other
-- about which rows exist, because they are all computed from the same
-- `base` CTE within the same statement. What is NOT guaranteed: the
-- overview snapshot and a separate, later call to the period-analytics
-- function are not guaranteed to reflect the identical instant (a write
-- landing in the gap between two separate round trips can appear in one
-- and not the other) -- this is the ordinary, expected behavior of any two
-- independent reads of a live database, not a bug; it is categorically
-- different from R2-03's finding, which was that a SINGLE logical
-- "give me all N rows" operation could itself skip or duplicate rows
-- against its own total.
--
-- SECURITY INVOKER, not DEFINER: both are called through the dashboard's
-- normal RLS-bound client (features/organizations/current.ts's session),
-- so they run with the caller's own privileges and RLS applies to every
-- table they touch exactly as it would to a hand-written query -- passing
-- an organization_id the caller isn't a member of returns zero rows via
-- RLS regardless of what the function's own WHERE clause says, the same
-- authorization boundary every other query in this app already relies on.
-- EXECUTE is explicitly restricted to `authenticated` per the R2-07 fix
-- (see the migration immediately after this one) rather than relying on a
-- PUBLIC-only revoke.

create or replace function public.get_feedback_overview_snapshot(p_organization_id bigint)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  with bounds as (
    select (date_trunc('day', now() at time zone 'utc') at time zone 'utc') as today_start
  ),
  base as (
    select f.*
    from public.feedback f
    where f.organization_id = p_organization_id
  ),
  recent as (
    select r.id, r.rating, r.feedback_text, r.status, r.created_at, l.name as location_name
    from base r
    join public.locations l on l.id = r.location_id
    order by r.created_at desc, r.id desc
    limit 5
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'averageRating', (select avg(rating) from base),
    'todayCount', (select count(*) from base, bounds where base.created_at >= bounds.today_start),
    'thisWeekCount', (select count(*) from base, bounds where base.created_at >= bounds.today_start - interval '6 days'),
    'unresolvedNegativeCount', (select count(*) from base where rating <= 2 and status <> 'resolved'),
    'ratingCounts', jsonb_build_object(
      '1', (select count(*) from base where rating = 1),
      '2', (select count(*) from base where rating = 2),
      '3', (select count(*) from base where rating = 3),
      '4', (select count(*) from base where rating = 4),
      '5', (select count(*) from base where rating = 5)
    ),
    'recent', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'rating', rating,
        'feedbackText', feedback_text,
        'status', status,
        'createdAt', created_at,
        'locationName', location_name
      ) order by created_at desc, id desc), '[]'::jsonb)
      from recent
    )
  );
$$;

create or replace function public.get_feedback_period_analytics(
  p_organization_id bigint,
  p_since timestamptz,
  p_days int
)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  with base as (
    select f.*
    from public.feedback f
    where f.organization_id = p_organization_id
      and f.created_at >= p_since
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
  );
$$;

revoke execute on function public.get_feedback_overview_snapshot(bigint) from public, anon;
grant execute on function public.get_feedback_overview_snapshot(bigint) to authenticated;

revoke execute on function public.get_feedback_period_analytics(bigint, timestamptz, int) from public, anon;
grant execute on function public.get_feedback_period_analytics(bigint, timestamptz, int) to authenticated;
