-- Finding: the feedback_update RLS policy is row-level only -- it lets any
-- org member UPDATE the row at all, but Postgres RLS has no concept of
-- "only these columns." The dashboard's own update action (see
-- features/feedback/inbox-actions.ts) only ever sets status/internal_note,
-- but nothing at the database layer stopped a direct
-- `update feedback set rating = 5, feedback_text = '...' where id = ...`
-- from a member's authenticated session -- silently rewriting a customer's
-- original rating or written feedback after the fact. The previous
-- migration (add_feedback_internal_note) even said this out loud: "the
-- existing feedback_update policy already covers arbitrary column updates
-- for org members" -- documented as fine, but it isn't: RLS is a row-level
-- boundary, not a column-level one, and this table needs both.
--
-- Fixed the same way organization_id immutability already is (see
-- prevent_organization_id_change): a trigger, not column-level GRANTs.
-- GRANT UPDATE (col, ...) would need to be paired with REVOKE UPDATE ON
-- feedback FROM authenticated first, and still wouldn't apply to the
-- service_role/admin client (which owns the table and bypasses column
-- privileges same as it bypasses RLS) -- so it wouldn't guard against a
-- future bug in server-side admin code either. A trigger fires for every
-- caller regardless of role, which is the actual invariant here: the
-- customer-authored content and origin of a feedback row must never change
-- after submission, full stop.

create or replace function private.prevent_feedback_content_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rating <> old.rating
    or new.feedback_text is distinct from old.feedback_text
    or new.location_id <> old.location_id
    or new.nfc_card_id <> old.nfc_card_id
    or new.created_at <> old.created_at
  then
    raise exception 'feedback rating, feedback_text, location_id, nfc_card_id, and created_at cannot be changed after submission -- only status and internal_note are editable';
  end if;
  return new;
end;
$$;

create trigger feedback_prevent_content_change
  before update on public.feedback
  for each row execute function private.prevent_feedback_content_change();
