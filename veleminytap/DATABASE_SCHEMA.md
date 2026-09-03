# Database Schema

Postgres via Supabase. Imperative migrations in `supabase/migrations/`, applied in order:

1. `20260903150741_core_schema_and_rls.sql` — organizations, memberships, locations, nfc_cards, feedback, RLS.
2. `20260903161454_add_feedback_internal_note.sql` — `feedback.internal_note`.
3. `20260903173818_add_priority_profiles_org_settings.sql` — `feedback.priority`, `organizations.notification_email`/`logo_url`, `profiles` table + signup trigger.

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

Belongs to one location (and, denormalized, one organization). `public_id` is a random UUID, not the internal `id` — this is what appears in the public URL (`/r/{public_id}`), so internal sequential IDs are never exposed. `status` ∈ `{active, inactive}`; an inactive card's public page refuses new submissions.

### `feedback`

Belongs to one org/location/nfc_card (all three denormalized for RLS and query performance — see consistency triggers below). `rating` constrained `1..5` at the database level. `feedback_text` nullable, ≤ 1000 chars (validated in the Server Action; DB constraint caps at 5000 as a hard backstop). `status` ∈ `{new, in_progress, resolved}`. `internal_note` — dashboard-only, never shown to the customer. `priority` — **generated column**, `high` (rating ≤ 2) / `medium` (rating = 3) / `normal` (rating ≥ 4), always derived from `rating` and never independently writable.

### `profiles`

One row per `auth.users` row, auto-created by the `on_auth_user_created` trigger. Currently holds only `full_name`; nothing in the app reads it yet (the dashboard header shows the org name, not the user's name). Added ahead of need because retrofitting after real users exist is more disruptive than creating it empty.

## Indexes

Every FK column used in an RLS predicate is indexed (`organization_id` on memberships/locations/nfc_cards/feedback; `location_id`/`nfc_card_id` where used as join keys). `feedback (organization_id, created_at desc)` backs the newest-first inbox; `feedback (organization_id, status)` backs unresolved filtering; `feedback (organization_id, priority)` backs "unresolved high-priority first" queries.

## Data-integrity triggers (defense beyond RLS)

- `private.set_updated_at()` — generic `updated_at` bump, on every tenant-owned table.
- `private.prevent_organization_id_change()` — blocks `UPDATE`s that move a row from one org to another (relevant for a user who belongs to more than one org: without this, an `UPDATE ... WITH CHECK` policy alone could allow moving a row between two orgs the same user belongs to).
- `private.validate_nfc_card_organization()` — on `nfc_cards` insert/update, checks `organization_id` actually matches the referenced `location_id`'s organization. Without this, a member could construct an `nfc_card` whose `organization_id` passes RLS but whose `location_id` points at a different org's location.
- `private.validate_feedback_consistency()` — same idea for `feedback`: `organization_id`/`location_id` must match the referenced `nfc_card`'s own org/location.

These exist because `organization_id`/`location_id` are denormalized (duplicated) rather than purely derived through joins; the triggers are what keeps the duplication from silently drifting and corrupting the tenant boundary.

## Row Level Security

RLS is enabled on every table in `public`. Policy shape, uniformly: `to authenticated using (private.is_org_member(organization_id))`, with a matching `with check` on `insert`/`update` policies. `private.is_org_member()` is `SECURITY DEFINER` (needed to read `organization_memberships` without recursively triggering that table's own RLS) but is narrowly scoped: `stable`, `set search_path = ''`, takes one argument, checks `auth.uid()` internally, lives in the non-exposed `private` schema, and its `EXECUTE` grant is revoked from `public` and re-granted only to `authenticated`.

No table has an `anon`/`authenticated` **insert** policy for `organizations`, `organization_memberships`, or `feedback` — those writes happen exclusively through privileged server-side code (org bootstrap on signup, public feedback submission) using the secret-key admin client, which bypasses RLS by design. This is the one deliberate RLS bypass in the system; see `ARCHITECTURE.md` and `SECURITY.md`.

`profiles` follows the standard "own row only" pattern: `select`/`update` `using (auth.uid()) = id)`, no policy lets a user read another user's profile.

## Types

`lib/supabase/database.types.ts` is hand-written (no local Docker environment for `supabase gen types`) and updated by hand alongside every migration. `feedback.priority` is typed on `Row` only, not `Insert`/`Update`, since Postgres computes it and the app must never attempt to set it directly.
