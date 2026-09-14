-- Round-14 R14-01 (P1). The password-change guard added the day before this
-- was a cookie whose only check was that it EXISTED:
--
--     return store.get("pw_recovery_grant") !== undefined;
--
-- A cookie is client-supplied input. `HttpOnly` restricts what scripts may
-- READ from the browser's own jar; it says nothing about the authenticity of a
-- Cookie header arriving at the server, and the request does not carry those
-- attributes back as proof. The exact threat the guard was written to close --
-- someone in control of an already-signed-in browser -- is also someone who
-- can add `pw_recovery_grant=anything` to a request. So the guard supplied no
-- authorization at all against the only attacker it named.
--
-- What a grant has to be instead, and what this migration gives it:
--
--   * SERVER-SIDE. The cookie now carries a random opaque token; the row here
--     is the fact. Nothing the client sends is believed on its own.
--   * BOUND TO A USER. Consuming a grant requires the caller's own verified
--     user id to match the row's. Another account's grant is useless.
--   * EXPIRING, checked on the server against the database clock rather than
--     against a maxAge the browser is free to ignore.
--   * SINGLE-USE, enforced by an atomic conditional UPDATE rather than by a
--     later DELETE. "Delete it afterwards" loses every race; two concurrent
--     replays of the same token would both pass a read-then-write check.
--
-- Only the token's SHA-256 is stored. A leaked database backup therefore does
-- not hand anyone a usable grant, the same reasoning the notification-email
-- confirmation token already follows.

create table public.password_recovery_grants (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index password_recovery_grants_user_id_idx
  on public.password_recovery_grants (user_id);

-- RLS on with NO policies: this table is service_role-only, reachable solely
-- through the three functions below. `anon`/`authenticated` inherit no access
-- from PUBLIC because every grant is revoked explicitly at the bottom.
alter table public.password_recovery_grants enable row level security;

revoke all on table public.password_recovery_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.password_recovery_grants to service_role;

-- ---------------------------------------------------------------------------
-- Issued at exactly one moment: a recovery link whose OTP verification has
-- already succeeded. Any earlier unconsumed grant for the same user is
-- expired first, so requesting a second recovery email invalidates the first
-- link's grant rather than leaving two live.

create function public.issue_password_recovery_grant(
  p_user_id uuid,
  p_token_hash text,
  p_ttl_seconds int default 900
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.password_recovery_grants
  set consumed_at = clock_timestamp()
  where user_id = p_user_id
    and consumed_at is null;

  insert into public.password_recovery_grants (user_id, token_hash, expires_at)
  values (
    p_user_id,
    p_token_hash,
    clock_timestamp() + make_interval(secs => greatest(1, p_ttl_seconds))
  );
end;
$$;

revoke execute on function public.issue_password_recovery_grant(uuid, text, int) from public, anon, authenticated;
grant execute on function public.issue_password_recovery_grant(uuid, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- The authorization decision. Returns true AT MOST ONCE per grant.
--
-- Lock first, then read the clock -- the rule this project has now had to
-- learn in seven separate places (see 20260910120000's header for the list).
-- A row locked before `clock_timestamp()` is read cannot be consumed by a
-- concurrent caller between the check and the write, and the expiry cannot be
-- evaluated against a moment that precedes a lock wait.

create function public.consume_password_recovery_grant(
  p_user_id uuid,
  p_token_hash text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.password_recovery_grants%rowtype;
  v_now timestamptz;
begin
  select * into v_row
  from public.password_recovery_grants
  where token_hash = p_token_hash
  for update;

  if not found then
    return false;
  end if;

  v_now := clock_timestamp();

  -- A grant belonging to someone else is not a grant. This is what stops a
  -- second account's valid cookie being replayed into this session.
  if v_row.user_id is distinct from p_user_id then
    return false;
  end if;
  if v_row.consumed_at is not null then
    return false;
  end if;
  if v_row.expires_at <= v_now then
    return false;
  end if;

  update public.password_recovery_grants
  set consumed_at = v_now
  where id = v_row.id;

  return true;
end;
$$;

revoke execute on function public.consume_password_recovery_grant(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_password_recovery_grant(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Read-only, for deciding whether to RENDER the current-password field. It
-- deliberately does not consume: a page load is not a password change, and a
-- user who reloads the form before submitting must not lose their grant.
--
-- This is a rendering hint and never an authorization decision. The Server
-- Action calls consume_password_recovery_grant() and believes only that.

create function public.password_recovery_grant_is_valid(
  p_user_id uuid,
  p_token_hash text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.password_recovery_grants
    where token_hash = p_token_hash
      and user_id = p_user_id
      and consumed_at is null
      and expires_at > clock_timestamp()
  );
$$;

revoke execute on function public.password_recovery_grant_is_valid(uuid, text) from public, anon, authenticated;
grant execute on function public.password_recovery_grant_is_valid(uuid, text) to service_role;
