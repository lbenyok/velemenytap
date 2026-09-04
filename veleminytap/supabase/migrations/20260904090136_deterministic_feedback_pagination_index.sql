-- Finding #9: the feedback inbox's cursor pagination (app/dashboard/feedback/page.tsx)
-- ordered by created_at alone and used `created_at < cursor` as the seek
-- predicate. Two feedback rows can share the exact same created_at (down to
-- microsecond resolution this is rare from real customer taps, but not from
-- a burst -- e.g. the rate-limit fixture in
-- e2e/public-submission-safety.spec.ts inserts 20 rows back to back, and
-- more importantly a real "busy checkout counter" scenario the rate limit
-- was deliberately sized to tolerate). Without a tiebreaker, Postgres gives
-- no ordering guarantee among equal-created_at rows, and a page boundary
-- that falls in the middle of a tied group can silently skip whichever of
-- them didn't happen to land on the earlier page -- not a duplicate (which
-- would at least be visible), a row that never appears in the inbox at all.
--
-- Fixed by ordering (and seeking) on (created_at, id) as a compound key:
-- id is a strictly increasing identity column, so it's a true tiebreaker
-- with no possibility of its own ties. This index supports that compound
-- order/seek efficiently, replacing the old (organization_id, created_at)
-- index it's a superset of.

drop index if exists public.feedback_org_created_at_idx;

create index feedback_org_created_at_id_idx
  on public.feedback (organization_id, created_at desc, id desc);
