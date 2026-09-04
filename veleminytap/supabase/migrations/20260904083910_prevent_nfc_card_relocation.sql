-- Finding: nothing stops an org member from changing an nfc_card's
-- location_id (validate_nfc_card_organization only checks the *new*
-- location belongs to the same organization -- it never compared against
-- the *old* location_id, so relocating a card to a different location in
-- the same org silently passed). feedback.location_id/organization_id are
-- denormalized onto each feedback row at submission time specifically so
-- historical feedback stays attributed to where it actually happened (see
-- feedback_validate_consistency and analytics/overview-data.ts, which joins
-- feedback -> locations through feedback's own frozen location_id, not
-- through the card's current one). Relocating a card doesn't corrupt that
-- historical data -- it's still frozen correctly -- but it does mean the
-- SAME nfc_card_id now spans two different locations' feedback over time,
-- which breaks any "feedback volume/rating by NFC card" analytics that
-- assumes a card maps to one location, and breaks the customer's own mental
-- model of what a "card" is at a physical premises (a card taped to Table 5
-- suddenly counting as Table 12's data if it's peeled off and moved).
--
-- Fix: make location_id immutable on nfc_cards, mirroring the existing
-- organization_id immutability pattern. A business that physically moves a
-- card should deactivate it and issue a new one at the new location --
-- consistent with the product's card model (see PRODUCT_SPEC.md: multiple
-- cards per location, one card = one placement), and far simpler than
-- trying to define what "correct" historical attribution means for a card
-- that changes location mid-lifetime.

create or replace function private.prevent_nfc_card_location_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_id <> old.location_id then
    raise exception 'nfc_card location_id cannot be changed -- deactivate this card and create a new one at the new location instead';
  end if;
  return new;
end;
$$;

create trigger nfc_cards_immutable_location
  before update on public.nfc_cards
  for each row execute function private.prevent_nfc_card_location_change();

-- Read-only diagnostic: rows where a feedback item's own (frozen,
-- authoritative) organization_id/location_id no longer matches its
-- nfc_card's current organization_id/location_id. Should always be empty
-- from this point forward (relocation is now blocked above), but this
-- covers any drift that already happened before this migration -- e.g. from
-- a direct database edit, or from the exact gap this migration closes.
-- Not exposed to PostgREST (private schema); query it directly:
--   select * from private.feedback_location_drift;
create or replace view private.feedback_location_drift
with (security_invoker = true)
as
select
  f.id as feedback_id,
  f.nfc_card_id,
  f.organization_id as feedback_organization_id,
  f.location_id as feedback_location_id,
  c.organization_id as card_current_organization_id,
  c.location_id as card_current_location_id,
  f.created_at as feedback_created_at
from public.feedback f
join public.nfc_cards c on c.id = f.nfc_card_id
where f.organization_id <> c.organization_id
   or f.location_id <> c.location_id;
