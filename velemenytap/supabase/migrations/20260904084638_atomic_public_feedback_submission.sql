-- Findings #6 and #2: the public submission path (features/feedback/actions.ts)
-- previously did a separate SELECT (lookupPublicCard, checking card/location
-- status) and then a separate INSERT via the admin client -- two round trips
-- with no transaction tying them together. Between them, the card/location
-- could be deactivated (a manager clicking "deactivate" at exactly the wrong
-- moment) and the insert would still go through: a real TOCTOU race, not
-- just a theoretical one, since both requests hit the same database with no
-- lock held across them.
--
-- Also, the app's own comment on this endpoint says outright: "no IP-based
-- or Redis-backed rate limiting, deliberately... not justified for MVP."
-- That's a reasonable call for casual double-taps (the existing cookie
-- handles that), but it leaves the endpoint open to a scripted flood: unlike
-- the cookie, a script can submit as fast as the network allows, from as
-- many "duplicate_guard" cookie jars as it wants. Each submission that
-- happens to be a low rating also triggers a real Resend email to the
-- business owner (see negative-feedback-alert.ts) -- so an unbounded flood
-- isn't just noisy data, it's an email-amplification vector that could
-- exhaust Resend's sending quota or bury a real alert in noise.
--
-- Fixed both by moving the whole check-and-insert into one atomic,
-- narrowly-scoped Postgres function instead of two round trips from Node:
--   1. `for update of c` locks the card row for the duration of the
--      transaction, so a concurrent deactivation either completes first
--      (and this function then correctly sees "inactive") or waits until
--      this insert has already committed -- no window where the check and
--      the insert can observe different states.
--   2. A per-card submission count over a trailing window rejects the
--      request outright once the rate is clearly beyond anything a real
--      customer tapping a physical card could produce. 20 per 5 minutes is
--      deliberately generous (a busy checkout counter could plausibly see a
--      handful of taps in a few minutes) while still cutting off a script
--      that would otherwise submit as fast as the network allows.
-- The alert-email cooldown (nfc_cards.last_negative_alert_at, used by
-- negative-feedback-alert.ts) is the second half of the amplification fix:
-- even within the rate limit, a burst of low ratings on one card sends at
-- most one alert email per cooldown window, not one per submission.

alter table public.nfc_cards add column last_negative_alert_at timestamptz;

-- SECURITY INVOKER, not DEFINER: the only caller is the admin (service_role)
-- client, which already bypasses RLS at the connection-role level (it has
-- bypassrls), so there's no privilege this function needs that its caller
-- doesn't already have -- and INVOKER carries none of DEFINER's
-- privilege-escalation risk if the grant below is ever loosened by mistake.
-- Must live in `public` (not `private`) to be reachable as an RPC at all --
-- PostgREST only resolves functions from api.schemas in config.toml -- so
-- the REVOKE/GRANT below is what actually keeps this from being a public
-- endpoint, the same way private.* functions rely on schema exposure alone.
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
  for update of c;

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

revoke all on function public.submit_feedback_atomic(uuid, smallint, text) from public;
grant execute on function public.submit_feedback_atomic(uuid, smallint, text) to service_role;
