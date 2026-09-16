-- The public rating flow now saves the rating on the star tap itself, and the
-- optional written comment arrives afterwards, on a second request. That needs
-- one thing the schema forbade outright: writing feedback_text onto a row that
-- already exists.
--
-- private.prevent_feedback_content_change (20260904083908) makes a feedback
-- row's customer-authored content immutable for EVERY caller, service_role
-- included, and that is still the right default. This migration carves out
-- exactly one transition and makes it reachable from exactly one place:
--
--   * feedback_text may go from NULL to a value -- never from one value to
--     another, never back to NULL, and nothing else on the row may change in
--     the same statement;
--   * only while the transaction-local setting app.allow_feedback_comment_attach is
--     'on', which only public.attach_feedback_comment sets, and which it clears
--     again before returning;
--   * and attach_feedback_comment is EXECUTE-restricted to service_role.
--
-- PostgREST gives anon/authenticated no way to call set_config (pg_catalog is
-- not an exposed schema), so the setting cannot be forged from a client.
--
-- The authority to attach a comment is a single-use grant, the same shape as
-- public.password_recovery_grants (round-14 R14-01): the customer's browser
-- holds a random token in an HttpOnly cookie, and the server stores only its
-- SHA-256, bound to one feedback row, with an expiry judged by the database
-- clock. The cookie is a lookup key, not a permission.
--
-- Expand-safe: a new table, two new functions, and a trigger function that only
-- ever permits MORE than before, in a case no deployed code exercises. Old code
-- never calls either function.

create table public.feedback_comment_grants (
  feedback_id bigint primary key references public.feedback (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.feedback_comment_grants enable row level security;

-- No policies on purpose: nobody but service_role reads or writes this table.
revoke all on table public.feedback_comment_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.feedback_comment_grants to service_role;

-- Issued by the server immediately after submit_feedback_atomic succeeds. A
-- separate call rather than a new submit_feedback_atomic signature, so the
-- function every deployed build already calls keeps its exact shape.
create function public.issue_feedback_comment_grant(
  p_feedback_id bigint,
  p_token_hash text,
  p_ttl_seconds int default 1800
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.feedback_comment_grants (feedback_id, token_hash, expires_at)
  values (
    p_feedback_id,
    p_token_hash,
    clock_timestamp() + make_interval(secs => greatest(1, least(p_ttl_seconds, 3600)))
  );
end;
$$;

revoke execute on function public.issue_feedback_comment_grant(bigint, text, int) from public, anon, authenticated;
grant execute on function public.issue_feedback_comment_grant(bigint, text, int) to service_role;

-- Returns one of: 'attached', 'invalid', 'used', 'expired', 'has_text'.
--
-- Lock order: the grant row, then the feedback row. The clock is read only
-- after both are held, so an expiry decision can never be made on an instant
-- that passed while this call waited (the clock-before-lock class; see
-- 20260910120000).
create function public.attach_feedback_comment(
  p_token_hash text,
  p_feedback_text text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_grant public.feedback_comment_grants%rowtype;
  v_existing_text text;
  v_now timestamptz;
begin
  if p_feedback_text is null or btrim(p_feedback_text) = '' then
    return 'invalid';
  end if;

  select * into v_grant
  from public.feedback_comment_grants
  where token_hash = p_token_hash
  for update;

  if not found then
    return 'invalid';
  end if;

  select f.feedback_text into v_existing_text
  from public.feedback f
  where f.id = v_grant.feedback_id
  for update;

  v_now := clock_timestamp();

  if v_grant.consumed_at is not null then
    return 'used';
  end if;
  if v_grant.expires_at <= v_now then
    return 'expired';
  end if;
  if v_existing_text is not null then
    return 'has_text';
  end if;

  perform set_config('app.allow_feedback_comment_attach', 'on', true);

  update public.feedback
  set feedback_text = p_feedback_text
  where id = v_grant.feedback_id;

  perform set_config('app.allow_feedback_comment_attach', '', true);

  update public.feedback_comment_grants
  set consumed_at = v_now
  where feedback_id = v_grant.feedback_id;

  return 'attached';
end;
$$;

revoke execute on function public.attach_feedback_comment(text, text) from public, anon, authenticated;
grant execute on function public.attach_feedback_comment(text, text) to service_role;

create or replace function private.prevent_feedback_content_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The one sanctioned change: a first comment on a rating saved without
  -- one, inside public.attach_feedback_comment.
  if old.feedback_text is null
    and new.feedback_text is not null
    and coalesce(current_setting('app.allow_feedback_comment_attach', true), '') = 'on'
    and new.rating = old.rating
    and new.location_id = old.location_id
    and new.nfc_card_id = old.nfc_card_id
    and new.created_at = old.created_at
  then
    return new;
  end if;

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
