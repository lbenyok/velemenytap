-- Round 2 finding R2-05: submit_feedback_atomic's `for update of c` locks
-- only the nfc_cards row -- the locations row it also reads `status` from
-- is never locked. Confirmed with two real concurrent database connections
-- (not simulated, not inferred): client A runs the function's exact SELECT
-- (locking only the card), reads location status as 'active'; client B
-- concurrently deactivates the location and commits immediately, since
-- nothing held a lock on it; client A -- still holding its stale read --
-- proceeds to insert feedback for a location that is, by the time the
-- insert lands, already inactive. This is a distinct race from the one
-- finding #6 (round 1) fixed and tested: that test deactivated the *card*
-- between page load and submission -- a page-load-to-submission gap this
-- function's card lock always closed correctly. This gap is *within* the
-- function itself, on the *location*, and no test exercising only card
-- deactivation could ever have caught it.
--
-- Fixed by locking both rows in the same statement: `for update of c, l`.
-- Postgres acquires both row locks as part of executing this one SELECT,
-- so there is no window between "lock the card" and "lock the location"
-- for a concurrent update to land in.
--
-- Lock acquisition order / deadlock analysis: this is the only code path
-- in the schema that ever locks nfc_cards and locations together. Every
-- other write to either table (activating/deactivating a card, activating/
-- deactivating a location, editing a card's display_name) is a single-table
-- UPDATE that never contends for a row lock on the other table. Deadlock
-- requires two transactions each holding one resource while waiting for
-- the other, in opposite orders -- since no other transaction ever
-- acquires these two locks in the reverse order (or acquires only one of
-- them while another transaction wants both), that scenario cannot arise
-- here. If a future function ever needs to lock both tables together, it
-- must do so in the same order this one does (nfc_cards then locations, as
-- implied by the join) to preserve this property.

create or replace function public.submit_feedback_atomic(
  p_public_id uuid,
  p_rating smallint,
  p_feedback_text text
)
returns table (
  feedback_id bigint,
  organization_id bigint,
  organization_name text,
  location_id bigint,
  location_name text,
  nfc_card_id bigint,
  card_name text,
  google_review_url text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_card_id bigint;
  v_org_id bigint;
  v_org_name text;
  v_loc_id bigint;
  v_loc_name text;
  v_card_name text;
  v_card_status text;
  v_loc_status text;
  v_google_review_url text;
  v_recent_count integer;
  v_feedback_id bigint;
begin
  select c.id, c.organization_id, o.name, c.location_id, l.name, c.display_name,
         c.status, l.status, l.google_review_url
    into v_card_id, v_org_id, v_org_name, v_loc_id, v_loc_name, v_card_name,
         v_card_status, v_loc_status, v_google_review_url
  from public.nfc_cards c
  join public.organizations o on o.id = c.organization_id
  join public.locations l on l.id = c.location_id
  where c.public_id = p_public_id
  for update of c, l;

  if v_card_id is null then
    raise exception 'card not found' using errcode = 'VT001';
  end if;

  if v_card_status <> 'active' or v_loc_status <> 'active' then
    raise exception 'card or location is inactive' using errcode = 'VT002';
  end if;

  select count(*) into v_recent_count
  from public.feedback f
  where f.nfc_card_id = v_card_id
    and f.created_at > now() - interval '5 minutes';

  if v_recent_count >= 20 then
    raise exception 'too many submissions for this card recently' using errcode = 'VT003';
  end if;

  insert into public.feedback (organization_id, location_id, nfc_card_id, rating, feedback_text)
  values (v_org_id, v_loc_id, v_card_id, p_rating, p_feedback_text)
  returning id into v_feedback_id;

  return query select
    v_feedback_id, v_org_id, v_org_name, v_loc_id, v_loc_name, v_card_id, v_card_name, v_google_review_url;
end;
$$;
