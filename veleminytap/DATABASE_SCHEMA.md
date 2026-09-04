# Database Schema

Postgres via Supabase. Imperative migrations in `supabase/migrations/`, applied in order:

1. `20260903150741_core_schema_and_rls.sql` — organizations, memberships, locations, nfc_cards, feedback, RLS.
2. `20260903161454_add_feedback_internal_note.sql` — `feedback.internal_note`.
3. `20260903173818_add_priority_profiles_org_settings.sql` — `feedback.priority`, `organizations.notification_email`/`logo_url`, `profiles` table + signup trigger.
4. `20260904083908_restrict_feedback_update_columns.sql` — trigger rejecting `UPDATE`s to `feedback`'s customer-authored/origin columns (rating, feedback_text, location_id, nfc_card_id, created_at); only `status`/`internal_note` are editable after submission.
5. `20260904083910_prevent_nfc_card_relocation.sql` — trigger making `nfc_cards.location_id` immutable, plus a read-only diagnostic view for any pre-existing drift.
6. `20260904084638_atomic_public_feedback_submission.sql` — `submit_feedback_atomic()`: the public submission path's active-status check and insert as one atomic, rate-limited database function; `nfc_cards.last_negative_alert_at` for the alert-email cooldown.
7. `20260904090136_deterministic_feedback_pagination_index.sql` — replaces the `(organization_id, created_at)` inbox index with `(organization_id, created_at desc, id desc)`, backing the compound cursor.
8. `20260904091127_atomic_idempotent_organization_creation.sql` — `create_organization_atomic()`: onboarding as one atomic, idempotent, per-user-serialized database function; enables the `unaccent` extension for accent-stripped slugs.

Never hand-edit the production schema outside a migration file (see `supabase` skill's Database Change Workflow). To change the schema: inspect current state → write a migration → preserve existing data → define FKs/constraints/RLS/indexes → update `database.types.ts` → update application code → verify authorized, unauthorized, and cross-tenant access.

## Tables

### `organizations`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | PK |
| `name` | text | not blank |
| `slug` | text | unique, not blank |
| `settings` | jsonb | default `{}`, unused today |
| `notification_email` | text | nullable; overrides per-member alert routing when set (§ Notifications) |
| `logo_url` | text | nullable; pasted URL, no upload UI (see `DECISIONS.md`) |
| `created_at`, `updated_at` | timestamptz | |

### `organization_memberships`

Connects `auth.users` to `organizations`. `role` ∈ `{owner, admin, manager, staff}` (only `owner` is ever assigned today — no invite flow exists). Unique on `(organization_id, user_id)`.

### `locations`

Belongs to one organization. `google_review_url` is nullable — a location can operate before its Google Review link is configured (the public page handles a missing URL gracefully, never fabricating one). `status` ∈ `{active, inactive}`.

### `nfc_cards`

Belongs to one location (and, denormalized, one organization) — **immutably**: `location_id` cannot be changed after creation (`private.prevent_nfc_card_location_change`, migration 5). A business that physically moves a card should deactivate it and issue a new one at the new location, not relocate the existing one; see that migration's comment for why (one card mapping to two locations over its lifetime breaks per-card analytics and the product's own card model). `public_id` is a random UUID, not the internal `id` — this is what appears in the public URL (`/r/{public_id}`), so internal sequential IDs are never exposed. `status` ∈ `{active, inactive}`; an inactive card's public page refuses new submissions. `last_negative_alert_at` — set by the negative-feedback alert email's cooldown claim (migration 6), not by anything customer-facing.

### `feedback`

Belongs to one org/location/nfc_card (all three denormalized for RLS and query performance — see consistency triggers below), and **immutably** once inserted: `organization_id`/`location_id`/`nfc_card_id`/`rating`/`feedback_text`/`created_at` cannot be changed by any `UPDATE`, from any role including a future admin-client bug (`private.prevent_feedback_content_change`, migration 4). Only `status` and `internal_note` are editable after submission — RLS alone only enforces *row* ownership, not *column* restriction, so this trigger is what actually stops an org member from rewriting a customer's original rating or written feedback. `rating` constrained `1..5` at the database level. `feedback_text` nullable, ≤ 1000 chars (validated in the Server Action; DB constraint caps at 5000 as a hard backstop). `status` ∈ `{new, in_progress, resolved}`. `internal_note` — dashboard-only, never shown to the customer. `priority` — **generated column**, `high` (rating ≤ 2) / `medium` (rating = 3) / `normal` (rating ≥ 4), always derived from `rating` and never independently writable.

### `profiles`

One row per `auth.users` row, auto-created by the `on_auth_user_created` trigger. Currently holds only `full_name`; nothing in the app reads it yet (the dashboard header shows the org name, not the user's name). Added ahead of need because retrofitting after real users exist is more disruptive than creating it empty.

## Indexes

Every FK column used in an RLS predicate is indexed (`organization_id` on memberships/locations/nfc_cards/feedback; `location_id`/`nfc_card_id` where used as join keys). `feedback (organization_id, created_at desc, id desc)` backs the newest-first inbox and its compound cursor pagination (migration 7 — `id` is a required tiebreaker, since `created_at` alone can tie between rows and a page boundary landing inside a tied group would otherwise silently skip whichever of them wasn't on the earlier page); `feedback (organization_id, status)` backs unresolved filtering; `feedback (organization_id, priority)` backs "unresolved high-priority first" queries.

## Data-integrity triggers (defense beyond RLS)

- `private.set_updated_at()` — generic `updated_at` bump, on every tenant-owned table.
- `private.prevent_organization_id_change()` — blocks `UPDATE`s that move a row from one org to another (relevant for a user who belongs to more than one org: without this, an `UPDATE ... WITH CHECK` policy alone could allow moving a row between two orgs the same user belongs to).
- `private.validate_nfc_card_organization()` — on `nfc_cards` insert/update, checks `organization_id` actually matches the referenced `location_id`'s organization. Without this, a member could construct an `nfc_card` whose `organization_id` passes RLS but whose `location_id` points at a different org's location.
- `private.validate_feedback_consistency()` — same idea for `feedback`: `organization_id`/`location_id` must match the referenced `nfc_card`'s own org/location.
- `private.prevent_feedback_content_change()` (migration 4) — blocks `UPDATE`s to `feedback`'s customer-authored/origin columns; only `status`/`internal_note` may change. RLS's row-level `feedback_update` policy alone permits rewriting any column, so this is the actual column-level restriction, not the RLS policy.
- `private.prevent_nfc_card_location_change()` (migration 5) — blocks any `UPDATE` that changes an `nfc_card`'s `location_id`.

These exist because `organization_id`/`location_id` are denormalized (duplicated) rather than purely derived through joins; the triggers are what keeps the duplication from silently drifting and corrupting the tenant boundary — plus, for the last two, enforcing invariants RLS structurally cannot express (RLS is row-scoped, not column-scoped, and has no notion of "immutable after insert").

## Row Level Security

RLS is enabled on every table in `public`. Policy shape, uniformly: `to authenticated using (private.is_org_member(organization_id))`, with a matching `with check` on `insert`/`update` policies. `private.is_org_member()` is `SECURITY DEFINER` (needed to read `organization_memberships` without recursively triggering that table's own RLS) but is narrowly scoped: `stable`, `set search_path = ''`, takes one argument, checks `auth.uid()` internally, lives in the non-exposed `private` schema, and its `EXECUTE` grant is revoked from `public` and re-granted only to `authenticated`.

No table has an `anon`/`authenticated` **insert** policy for `organizations`, `organization_memberships`, or `feedback`. Those writes happen through two different, deliberate bypass mechanisms — see `SECURITY.md` § "The deliberate RLS bypasses" for the full accounting and the security reasoning behind each: the secret-key admin client (server-only, used by public feedback submission, public card lookup, and negative-feedback alerts), and two narrowly-scoped `SECURITY DEFINER`/`SECURITY INVOKER` database functions (`submit_feedback_atomic`, `create_organization_atomic`) that replace what used to be plain multi-step admin-client inserts with a single atomic, validated operation.

`profiles` follows the standard "own row only" pattern: `select`/`update` `using (auth.uid()) = id)`, no policy lets a user read another user's profile.

## Database functions callable as RPCs

Beyond `private.is_org_member` (used only from within RLS policy evaluation, never called directly), two functions in `public` are meant to be invoked as PostgREST RPCs:

- **`submit_feedback_atomic(p_public_id, p_rating, p_feedback_text)`** (migration 6) — `SECURITY INVOKER`. Locks the target card row (`for update of c`), atomically re-checks card/location active status and a per-card submission-rate limit (20 per 5 minutes), then inserts the feedback row — closing the check-then-insert race the old two-round-trip flow had, and adding the rate limit the endpoint's own code previously said was deliberately absent. `EXECUTE` is revoked from `public`/`anon`/`authenticated` and granted only to `service_role`; `SECURITY INVOKER` (not `DEFINER`) because its only caller, the admin client, already bypasses RLS at the connection-role level, so there's no privilege this function needs beyond what its caller already has.
- **`create_organization_atomic(p_name)`** (migration 8) — `SECURITY DEFINER`, unlike every other function in this schema, because it must be callable directly by an authenticated user's own session to bootstrap their first organization, and there is deliberately no `INSERT` policy on `organizations`/`organization_memberships` for `authenticated` to invoke through otherwise. Idempotent (returns the caller's existing organization if they already have one) and serialized per user via `pg_advisory_xact_lock`. Mitigations for the `DEFINER` privilege: an explicit `auth.uid()` check as the first statement, `set search_path = ''`, and `EXECUTE` restricted to `authenticated` only (revoked from `public`/`anon`).

## Types

`lib/supabase/database.types.ts` is hand-written (no local Docker environment for `supabase gen types`) and updated by hand alongside every migration. `feedback.priority` is typed on `Row` only, not `Insert`/`Update`, since Postgres computes it and the app must never attempt to set it directly.
