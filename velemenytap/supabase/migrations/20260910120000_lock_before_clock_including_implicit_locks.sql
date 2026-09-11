-- Round 10 independent review, findings R10-06 (P2) and R10-07 (P2). A forward
-- migration; nothing already applied is edited.
--
-- This is the FIFTH round in which an instance of the same class has been
-- found, and every previous class-wide search missed the next one. The reason
-- is consistent: the defect is never at a statement that looks like a lock.
--
--   round 6-8  now() vs clock_timestamp(), and a clock read before an
--              EXPLICIT `select ... for update`.
--   round 9    a clock read before a lock taken implicitly by `UPDATE ...
--              WHERE`.
--   round 10   a clock read before a lock taken implicitly by a FOREIGN KEY
--              CHECK on `INSERT`, and before a later `UPDATE` in a function
--              whose earlier advisory lock made it look already serialized.
--
-- THE DEFECTS.
--
-- 1. reserve_notification_email_change reads the clock straight after its
--    advisory lock -- which is genuinely the right place for the advisory lock
--    -- but then UPDATEs public.organizations at the end. That UPDATE takes a
--    row lock of its own and can wait. The review held the organization row
--    with FOR NO KEY UPDATE (a mode deliberately compatible with the earlier
--    membership check, so only the final UPDATE blocks) and observed a
--    reservation stamped 1,522 ms before it was released. Every cooldown and
--    hourly-budget comparison in that call is backdated by the wait.
--
-- 2. claim_negative_alert_send was corrected in 20260909110000 to lock the
--    card row before reading the clock -- correct as far as it went. Its log
--    INSERT then needs a foreign-key check on public.organizations, which
--    takes FOR KEY SHARE on that row and waits for any conflicting FOR UPDATE.
--    Holding the organization produced a reservation 1,520 ms early. The
--    migration's own comment said "every lock this decision depends on is now
--    held", which was false: a foreign key is a lock.
--
-- 3. submit_feedback_atomic waits for the card and location locks and then
--    counts the last five minutes with now() -- TRANSACTION-START time, not
--    the current instant. The review seeded twenty submissions aged 299
--    seconds, blocked a new one behind the card lock for 1.5 s, and the
--    function rejected a legitimate guest with VT003 while the true trailing
--    five-minute count was ZERO. The inserted row's created_at DEFAULT now()
--    has the same problem, which then feeds the next caller's window.
--
-- THE FIX, stated as a rule rather than three patches: a time-based decision
-- is taken only after the transaction holds EVERY lock that can make it wait,
-- counting locks taken implicitly by a later UPDATE or by a foreign-key check.
-- Where such a lock exists, it is now acquired EXPLICITLY and up front, in the
-- mode the implicit operation would have used, so the wait happens before the
-- clock read instead of after it.
--
-- LOCK ORDER, so making these explicit cannot introduce deadlocks:
--
--     public.nfc_cards -> public.locations -> public.organizations
--
-- which is the order submit_feedback_atomic's own join already implied. This
-- is why claim_negative_alert_send takes the card first and the organization
-- second, even though the organization lock is the one being added: reversing
-- it would let a feedback submission and an alert claim for the same
-- organization deadlock against each other. reserve_notification_email_change
-- touches only organizations, so it has no ordering constraint, and its
-- FOR NO KEY UPDATE is compatible with the FOR KEY SHARE the other two take.
--
-- See BILLING_INVARIANTS.md § I6.

-- ---------------------------------------------------------------------------
-- 1. The notification-email reservation's own later UPDATE.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_notification_email_change(
  p_organization_id bigint,
  p_email text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_log_id bigint;
  v_recent_count int;
  v_cooldown_minutes int;
  v_org_hourly_budget int;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = 'VT201';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where organization_id = p_organization_id and user_id = v_user_id
  ) then
    raise exception 'not a member of this organization' using errcode = 'VT202';
  end if;

  select cooldown_minutes, org_hourly_budget
  into v_cooldown_minutes, v_org_hourly_budget
  from private.notification_email_change_config
  where organization_id = p_organization_id;
  if not found then
    v_cooldown_minutes := 5;
    v_org_hourly_budget := 5;
  end if;

  -- Serialized per organization -- without this, two concurrent requests
  -- for the same org could both read the same "under budget" snapshot and
  -- both proceed, overshooting the budget by as many concurrent callers as
  -- there were (exactly the round-3 R3-02 race, for a different budget).
  perform pg_advisory_xact_lock(hashtext('notification_email_change:' || p_organization_id::text));

  -- R10-06: the organization row lock the UPDATE at the end of this function
  -- would otherwise acquire only once every decision below had already been
  -- made against an older instant. Taken here, in the same mode that UPDATE
  -- uses, so the wait happens BEFORE the clock read rather than after it.
  perform 1 from public.organizations where id = p_organization_id for no key update;

  -- Every lock this decision can wait on is now held -- including the implicit
  -- one above, which is what the previous version of this claim missed.
  v_now := clock_timestamp();

  if exists (
    select 1 from private.notification_email_change_log
    where organization_id = p_organization_id
      and reserved_at > v_now - (v_cooldown_minutes || ' minutes')::interval
  ) then
    raise exception 'too many notification-email change requests -- try again in a few minutes' using errcode = 'VT203';
  end if;

  select count(*) into v_recent_count
  from private.notification_email_change_log
  where organization_id = p_organization_id
    and status in ('reserved', 'delivered')
    and reserved_at > v_now - interval '1 hour';

  if v_recent_count >= v_org_hourly_budget then
    raise exception 'hourly notification-email change budget exceeded' using errcode = 'VT204';
  end if;

  insert into private.notification_email_change_log (organization_id, status, reserved_at)
  values (p_organization_id, 'reserved', v_now)
  returning id into v_log_id;

  -- Records the candidate address now (validated + rate-limited) but
  -- deliberately leaves the token hash/expiry null -- issue_notification_
  -- email_change_token() (service_role only) sets those once it mints the
  -- actual token, immediately afterward, from trusted server code.
  perform set_config('app.allow_notification_email_change', 'true', true);
  update public.organizations
  set notification_email_pending = p_email,
      notification_email_pending_token_hash = null,
      notification_email_pending_expires_at = null
  where id = p_organization_id;

  return v_log_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The alert reservation's foreign-key lock.
-- ---------------------------------------------------------------------------

create or replace function public.claim_negative_alert_send(
  p_nfc_card_id bigint,
  p_cooldown_minutes int default 5,
  p_org_hourly_budget int default 30
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_recent_org_count integer;
  v_claimed_id bigint;
  v_log_id bigint;
  v_now timestamptz;
begin
  select organization_id into v_org_id from public.nfc_cards where id = p_nfc_card_id;
  if v_org_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('claim_negative_alert_send:' || v_org_id::text)::bigint);

  -- The card row lock, taken EXPLICITLY and before the clock read (round 9).
  -- First in the documented lock order.
  perform 1 from public.nfc_cards where id = p_nfc_card_id for update;

  -- R10-06: the INSERT into private.alert_email_log at the end carries a
  -- foreign key to public.organizations, and that check takes FOR KEY SHARE on
  -- the organization row -- which waits for any conflicting FOR UPDATE held
  -- elsewhere. Round 9 fixed the card row and then asserted that "every lock
  -- this decision depends on is now held"; a foreign key is a lock, and this
  -- one was still being taken after v_now had been fixed. Acquired here in the
  -- same mode, second in the documented lock order.
  perform 1 from public.organizations where id = v_org_id for key share;

  -- Now -- and only now -- is this the instant the decision is made at.
  v_now := clock_timestamp();

  select count(*) into v_recent_org_count
  from private.alert_email_log
  where organization_id = v_org_id
    and status <> 'failed'
    and reserved_at > v_now - interval '1 hour';

  if v_recent_org_count >= p_org_hourly_budget then
    return null;
  end if;

  perform set_config('app.allow_cooldown_update', 'true', true);
  update public.nfc_cards
  set last_negative_alert_at = v_now
  where id = p_nfc_card_id
    and (
      last_negative_alert_at is null
      or last_negative_alert_at < v_now - (p_cooldown_minutes || ' minutes')::interval
    )
  returning id into v_claimed_id;

  if v_claimed_id is null then
    return null;
  end if;

  insert into private.alert_email_log (organization_id, nfc_card_id, status, reserved_at)
  values (v_org_id, p_nfc_card_id, 'reserved', v_now)
  returning id into v_log_id;

  return v_log_id;
end;
$$;

revoke execute on function public.claim_negative_alert_send(bigint, int, int) from public, anon, authenticated;
grant execute on function public.claim_negative_alert_send(bigint, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Public feedback's rate window (R10-07).
-- ---------------------------------------------------------------------------
--
-- The one place in this codebase where a guest -- someone who tapped a card in
-- a real business, with no account and no way to report a problem -- is the
-- one who pays for the bug. A false VT003 is a customer standing at a counter
-- being told their feedback was rejected as spam.
--
-- Note this changes only WHICH INSTANT the window is measured from. The limit
-- itself (20 per card per 5 minutes) is unchanged, and the window still cannot
-- be widened by a slow caller: clock_timestamp() only ever moves forward, so
-- the trailing five minutes is measured from a later instant, never an earlier
-- one. This makes the limit MORE accurate, not more permissive.

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
  v_now timestamptz;
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

  -- R10-06/R10-07: the feedback INSERT below carries a foreign key to
  -- public.organizations, whose check takes FOR KEY SHARE and can wait. The
  -- card and location rows are already held FOR UPDATE by the select above
  -- (first and second in the documented lock order); organizations is the
  -- third, taken last, so nfc_cards -> locations -> organizations holds.
  perform 1 from public.organizations where id = v_org_id for key share;

  -- R10-07: now(), used here before, is TRANSACTION-START time -- fixed before
  -- the locks above were even waited for. A submission that queued 1.5 s
  -- behind the card lock counted a five-minute window that had already moved
  -- on, and rejected a legitimate guest with VT003 while the true count was
  -- zero. Both the decision and the row it writes now use one instant, read
  -- after every lock is held.
  v_now := clock_timestamp();

  select count(*) into v_recent_count
  from public.feedback f
  where f.nfc_card_id = v_card_id
    and f.created_at > v_now - interval '5 minutes';

  if v_recent_count >= 20 then
    raise exception 'too many submissions for this card recently' using errcode = 'VT003';
  end if;

  insert into public.feedback (organization_id, location_id, nfc_card_id, rating, feedback_text, created_at)
  values (v_org_id, v_loc_id, v_card_id, p_rating, p_feedback_text, v_now)
  returning id into v_feedback_id;

  return query select
    v_feedback_id, v_org_id, v_org_name, v_loc_id, v_loc_name, v_card_id, v_card_name, v_google_review_url;
end;
$$;
