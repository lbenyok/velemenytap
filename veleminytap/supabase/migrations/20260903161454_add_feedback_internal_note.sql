-- Internal note managers can attach to a feedback item (dashboard-only;
-- never shown to the customer). No RLS changes needed: the existing
-- feedback_update policy already covers arbitrary column updates for
-- org members.

alter table public.feedback add column internal_note text;

alter table public.feedback
  add constraint feedback_internal_note_length
  check (internal_note is null or char_length(internal_note) <= 5000);
