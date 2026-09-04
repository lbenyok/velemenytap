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
9. `20260904130921_tenant_scoped_analytics_aggregation.sql` (round 2, R2-02/R2-03/R2-04) — `get_feedback_overview_snapshot()`, `get_feedback_period_analytics()`: every analytics statistic computed inside one tenant-scoped SQL function call, replacing page-by-page row fetching (no row-count ceiling to hit, one consistent MVCC snapshot per call).
10. `20260904131144_enforce_rpc_role_allowlists.sql` (round 2, R2-07) — explicitly revokes/grants `EXECUTE` on `submit_feedback_atomic`/`create_organization_atomic` per-role, since this project's `ALTER DEFAULT PRIVILEGES` configuration granted `anon`/`authenticated`/`service_role` `EXECUTE` independently of `PUBLIC` (a `revoke ... from public` alone left those grants intact).
11. `20260904132712_lock_location_in_feedback_submission.sql` (round 2, R2-05) — `submit_feedback_atomic()` now locks the `locations` row it reads `status` from (`for update of c, l`), not just `nfc_cards` — closes a race where a location deactivated mid-transaction could still receive a feedback insert.
12. `20260904135437_server_owned_alert_cooldown_and_budget.sql` (round 2, R2-08) — `private.alert_email_log` table, a trigger making `nfc_cards.last_negative_alert_at` rejects any change except through `claim_negative_alert_send()`, and that function itself: a per-card cooldown plus an organization-wide hourly send budget.

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

Belongs to one location (and, denormalized, one organization) — **immutably**: `location_id` cannot be changed after creation (`private.prevent_nfc_card_location_change`, migration 5). A business that physically moves a card should deactivate it and issue a new one at the new location, not relocate the existing one; see that migration's comment for why (one card mapping to two locations over its lifetime breaks per-card analytics and the product's own card model). This is also enforced in the dashboard UI, not just the database (round 2, R2-09): the edit form shows an existing card's location as read-only text and `updateNfcCardAction`'s schema has no `location_id` field at all — the create form's editable dropdown remains for new cards. `public_id` is a random UUID, not the internal `id` — this is what appears in the public URL (`/r/{public_id}`), so internal sequential IDs are never exposed. `status` ∈ `{active, inactive}`; an inactive card's public page refuses new submissions. `last_negative_alert_at` — the negative-feedback alert cooldown timestamp. As of migration 12 (round 2, R2-08), this column can **only** be changed by `claim_negative_alert_send()` — a trigger (`private.prevent_direct_cooldown_update`) rejects any other `UPDATE` to it, from any role, including the admin client itself.

### `private.alert_email_log`

Added in migration 12 (round 2, R2-08). Append-only record of every negative-feedback alert actually sent: `organization_id`, `nfc_card_id`, `sent_at`. Not exposed to PostgREST (lives in the non-exposed `private` schema); only `service_role` has `select`/`insert` on it (see § Row Level Security). Backs `claim_negative_alert_send()`'s organization-wide hourly budget — indexed on `(organization_id, sent_at)`.

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
- `private.prevent_direct_cooldown_update()` (migration 12) — blocks any `UPDATE` that changes `nfc_cards.last_negative_alert_at` unless a transaction-local flag (`app.allow_cooldown_update`) is set, which only `claim_negative_alert_send()` ever sets. Same pattern as the two triggers above (a column RLS's row-level policies cannot restrict), applied to a column no legitimate dashboard action ever needs to touch directly, rather than one legitimate actions need to touch selectively.

These exist because `organization_id`/`location_id` are denormalized (duplicated) rather than purely derived through joins; the triggers are what keeps the duplication from silently drifting and corrupting the tenant boundary — plus, for the last two, enforcing invariants RLS structurally cannot express (RLS is row-scoped, not column-scoped, and has no notion of "immutable after insert").

## Row Level Security

RLS is enabled on every table in `public`. Policy shape, uniformly: `to authenticated using (private.is_org_member(organization_id))`, with a matching `with check` on `insert`/`update` policies. `private.is_org_member()` is `SECURITY DEFINER` (needed to read `organization_memberships` without recursively triggering that table's own RLS) but is narrowly scoped: `stable`, `set search_path = ''`, takes one argument, checks `auth.uid()` internally, lives in the non-exposed `private` schema, and its `EXECUTE` grant is revoked from `public` and re-granted only to `authenticated`.

No table has an `anon`/`authenticated` **insert** policy for `organizations`, `organization_memberships`, or `feedback`. Those writes happen through two different, deliberate bypass mechanisms — see `SECURITY.md` § "The deliberate RLS bypasses" for the full accounting and the security reasoning behind each: the secret-key admin client (server-only, used by public feedback submission, public card lookup, and negative-feedback alerts), and the `SECURITY DEFINER`/`SECURITY INVOKER` database functions below that replace what used to be plain multi-step admin-client inserts with a single atomic, validated operation.

`profiles` follows the standard "own row only" pattern: `select`/`update` `using (auth.uid()) = id)`, no policy lets a user read another user's profile.

`private.alert_email_log` (migration 12) has RLS enabled but no policies for `anon`/`authenticated` at all — the schema itself isn't exposed to PostgREST, and only `service_role` (via explicit `grant usage on schema private to service_role; grant select, insert on private.alert_email_log to service_role;`) can read or write it. `service_role`'s `bypassrls` does not substitute for these grants — RLS bypass and schema/table `GRANT`s are separate privilege types, confirmed the hard way when the migration was first applied without them and `claim_negative_alert_send` failed with "permission denied for schema private" even though its caller was `service_role`.

## Database functions callable as RPCs

Beyond `private.is_org_member` (used only from within RLS policy evaluation, never called directly), five functions in `public` are meant to be invoked as PostgREST RPCs:

- **`submit_feedback_atomic(p_public_id, p_rating, p_feedback_text)`** (migration 6, relocked in migration 11) — `SECURITY INVOKER`. Locks **both** the target card and location rows (`for update of c, l`), atomically re-checks card/location active status and a per-card submission-rate limit (20 per 5 minutes), then inserts the feedback row. Migration 6 closed the check-then-insert race the old two-round-trip flow had for the card; round 2 (R2-05) found the location row was never locked — a location deactivated mid-transaction could still receive an insert — and migration 11 extended the same `SELECT ... FOR UPDATE` to cover it. `EXECUTE` is restricted to `service_role` only (see the role-allowlist table below); `SECURITY INVOKER` (not `DEFINER`) because its only caller, the admin client, already bypasses RLS at the connection-role level, so there's no privilege this function needs beyond what its caller already has.
- **`create_organization_atomic(p_name)`** (migration 8) — `SECURITY DEFINER`, unlike every other function in this schema, because it must be callable directly by an authenticated user's own session to bootstrap their first organization, and there is deliberately no `INSERT` policy on `organizations`/`organization_memberships` for `authenticated` to invoke through otherwise. Idempotent (returns the caller's existing organization if they already have one) and serialized per user via `pg_advisory_xact_lock`. Mitigations for the `DEFINER` privilege: an explicit `auth.uid()` check as the first statement, `set search_path = ''`, and an explicit role allowlist (below).
- **`get_feedback_overview_snapshot(p_organization_id)`** / **`get_feedback_period_analytics(p_organization_id, p_since, p_days)`** (migration 9, round 2 R2-02/R2-03/R2-04) — both `SECURITY INVOKER`, `stable`, `language sql`. Called through the dashboard's own RLS-bound client (not the admin client), so RLS applies to every table they touch exactly as it would to a hand-written query. Each computes its entire result — totals, rating distribution, daily series, per-location/per-card breakdowns — as `jsonb` inside one statement built on a single shared `base` CTE, so every number in one call reflects one consistent MVCC snapshot; see `SECURITY.md` § "Analytics correctness" for the full consistency semantics and what replaced (page-by-page row fetching, which had both a silent row-count ceiling and `OFFSET`-pagination inconsistency under concurrent writes).
- **`claim_negative_alert_send(p_nfc_card_id, p_cooldown_minutes default 5, p_org_hourly_budget default 30)`** (migration 12, round 2 R2-08) — `SECURITY INVOKER`, same reasoning as `submit_feedback_atomic` (only caller is the admin client). Checks the organization's trailing-hour send count against `private.alert_email_log` first (so a budget-exhausted org never even attempts the cooldown update), then atomically claims the per-card cooldown via a flagged `UPDATE` (see `private.prevent_direct_cooldown_update` above) and logs the send. Returns `boolean` — `true` only if this call is the one that gets to send the email.

### RPC role allowlists (round 2, R2-07)

`revoke execute on function ... from public;` alone does **not** remove `anon`/`authenticated`'s ability to call a function on this project — this project's `ALTER DEFAULT PRIVILEGES` configuration grants `EXECUTE` on every new `public`-schema function directly to `anon`/`authenticated`/`service_role` as independent ACL entries, unaffected by a `PUBLIC`-only revoke. Migration 10 (plus migrations 9 and 12 doing the same for the functions they introduce) makes every RPC's role allowlist explicit instead of relying on that:

| Function | Revoked from | Granted to |
|---|---|---|
| `submit_feedback_atomic` | `public`, `anon`, `authenticated` | `service_role` |
| `create_organization_atomic` | `public`, `anon`, `service_role` | `authenticated` |
| `get_feedback_overview_snapshot` | `public`, `anon` | `authenticated` |
| `get_feedback_period_analytics` | `public`, `anon` | `authenticated` |
| `claim_negative_alert_send` | `public`, `anon`, `authenticated` | `service_role` |

Verified with `has_function_privilege()` for every role/function pair, and with real calls as `anon`/`authenticated`/`service_role` — not the grant-inspection check alone.

## Types

`lib/supabase/database.types.ts` is hand-written (no local Docker environment for `supabase gen types`) and updated by hand alongside every migration. `feedback.priority` is typed on `Row` only, not `Insert`/`Update`, since Postgres computes it and the app must never attempt to set it directly. `get_feedback_overview_snapshot`/`get_feedback_period_analytics` are typed with `Returns: Json` (they return `jsonb`) — `features/analytics/parse-snapshots.ts` is the one place that parses that `Json` into the app's actual typed shapes, discriminating an error/null result into `{ unavailable: true }` rather than trusting the shape blindly. `claim_negative_alert_send` is typed `Args: { p_nfc_card_id: number; p_cooldown_minutes?: number; p_org_hourly_budget?: number }; Returns: boolean`.
