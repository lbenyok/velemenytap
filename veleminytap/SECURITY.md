# Security

## Tenant isolation

This is a multi-tenant SaaS; cross-tenant data leakage is treated as critical severity. The tenant boundary is enforced at the database layer via Postgres RLS (`DATABASE_SCHEMA.md` § Row Level Security), not by application-level filtering — a query that "forgets" a `WHERE organization_id = ...` clause still cannot return another org's rows. Every RLS policy follows `private.is_org_member(organization_id)`, a single `SECURITY DEFINER` helper, so the tenant check is one auditable code path rather than duplicated per policy.

Denormalized `organization_id`/`location_id` columns (kept for RLS/query performance rather than requiring joins) are guarded against drift by trigger functions (`validate_nfc_card_organization`, `validate_feedback_consistency`) that re-derive the true value from the parent row and reject any insert/update where they disagree. `organization_id` itself is immutable post-creation (`prevent_organization_id_change`), closing the specific hole where a user belonging to two orgs could otherwise move a row between them via an `UPDATE`. `nfc_cards.location_id` is likewise immutable (`prevent_nfc_card_location_change`) — relocating a card to a different location isn't a tenant-isolation hole by itself, but it would let the same card span two locations' feedback history, breaking per-card analytics and the product's own card model.

RLS is a *row-level* boundary — it has no notion of restricting which *columns* an authorized `UPDATE` can touch. The `feedback_update` policy correctly restricts updates to rows the caller's org owns, but by itself would let any member rewrite a customer's original `rating`/`feedback_text` via a direct `UPDATE`, not just the `status`/`internal_note` fields the dashboard's own code ever sets. `private.prevent_feedback_content_change` closes that gap with a trigger that rejects changes to anything but `status`/`internal_note`, regardless of caller — including a hypothetical future bug in server-side admin code, since a trigger fires for every role, not just `authenticated`.

## Secrets

- `SUPABASE_SECRET_KEY` is read only in `lib/supabase/admin.ts`, which is guarded by `import "server-only"` — a build-time guarantee it can never enter a client bundle.
- No `NEXT_PUBLIC_*` variable holds a privileged credential; only the Supabase URL and publishable key are exposed to the browser.
- `.env.local` and `.env*.local` are gitignored; `.env.example` documents required variables without values.

## The deliberate RLS bypasses

An earlier version of this document claimed the admin (secret-key) client was used in exactly two places. That was wrong even at the time it was written — an independent review counted four, correctly. Both the count and the list below are current as of the migrations noted; re-verify with `grep -rln createAdminClient features app lib` (excluding `lib/supabase/admin.ts` itself) before trusting this list in the future, rather than assuming it stays accurate as the app grows.

### The admin (secret-key) client — bypasses RLS entirely, server-only

1. **Public card lookup** (`features/feedback/card-lookup.ts`) — renders the public NFC landing page (org/location name, Google Review URL, active status). Read-only. There is no authenticated user on this page, so `auth.uid()`-based RLS has nothing to check against; there is also deliberately no `anon` `select` policy on `nfc_cards`/`locations`/`organizations`.
2. **Public feedback submission** (`features/feedback/actions.ts`) — calls `submit_feedback_atomic` (below) via the admin client. The bypass is narrower than it looks: the RPC itself is `EXECUTE`-restricted to `service_role`, so even holding the admin client's credentials isn't sufficient on its own without also being that role — the two layers (client credential, function grant) are independent, not redundant.
3. **Negative-feedback alert email** (`features/notifications/negative-feedback-alert.ts`) — looks up an org's `notification_email` or its owner/admin/manager members' auth emails to send the alert, and performs the atomic alert-cooldown claim (`UPDATE nfc_cards ... WHERE last_negative_alert_at IS NULL OR < cutoff`). Read-only except for that one cooldown timestamp; never returns data to the client.

No other code path uses the admin client. Every dashboard read/write goes through the RLS-bound client (`lib/supabase/server.ts`), scoped to the signed-in user's own session. Organization creation (below) no longer uses the admin client at all — it used to be a fourth consumer (the count an earlier review corrected this document about), until it was rewritten as a `SECURITY DEFINER` database function instead.

### `SECURITY DEFINER`/`SECURITY INVOKER` database functions — the other bypass category

RLS can only be bypassed by a role with `bypassrls` (which the admin client's `service_role` has) or by a function whose privilege model routes around it. Two functions do the latter, both narrowly scoped and both documented in full in `DATABASE_SCHEMA.md` § "Database functions callable as RPCs":

- **`submit_feedback_atomic`** — `SECURITY INVOKER`. Not actually a privilege escalation: its only caller (the admin client) already bypasses RLS, so `INVOKER` just means it runs with privileges the caller already had. Its role here is atomicity and rate-limiting (see "Public endpoint hardening" below), not access it wouldn't otherwise have.
- **`create_organization_atomic`** — genuinely `SECURITY DEFINER`, the one function in this schema that is. Callable directly by an authenticated user's own session (not through the admin client) to bootstrap their first organization, since there is deliberately no `INSERT` policy on `organizations`/`organization_memberships` for `authenticated`. Per the standard checklist for a public-facing `DEFINER` function: `auth.uid()` is checked explicitly as the function's first statement (never trusts an implicit caller identity), `set search_path = ''` prevents search-path hijacking, and `EXECUTE` is revoked from `public`/`anon` and granted only to `authenticated`.

## Public endpoint hardening

`submitFeedbackAction` (`features/feedback/actions.ts`):
- zod validation on `public_id` (UUID), `rating` (1–5 int), `feedback_text` (≤ 1000 chars).
- Card existence and active-status re-checked **atomically with the insert**, not just at page load or in a separate round trip beforehand — `submit_feedback_atomic` locks the card row (`for update of c`) for the duration of the transaction, so a card being deactivated concurrently either completes first (and this correctly sees "inactive") or waits until the insert has already committed. An earlier version of this endpoint did the status check and the insert as two separate requests with no lock between them — a real race, not just a theoretical one, confirmed with a test that deactivates the card in the window between page load and submission (`e2e/public-submission-safety.spec.ts`).
- Database-backed per-card rate limit: `submit_feedback_atomic` rejects a submission once a card has received 20 or more within the trailing 5 minutes. Deliberately generous — sized to never trip on a real, if unusually busy, physical location — while cutting off a script that would otherwise submit as fast as the network allows.
- Alert-email cooldown (`nfc_cards.last_negative_alert_at`): even within the rate limit, a burst of low ratings on one card sends at most one alert email per 5-minute window, not one per qualifying submission — see "Negative-feedback alert email" above.
- Cookie-based duplicate-submission guard (below) — no personal data, opaque marker, card-scoped.

### Rate limiting: database-backed, not Redis

An earlier version of this document said rate limiting was deliberately not implemented for MVP, reasoning that Vercel's serverless functions don't share memory across instances so an in-process limiter would be unreliable without adding real infrastructure. That reasoning about in-process limiters was correct, but it's not actually a reason to have no rate limiting at all: Postgres is already the shared state every request goes through regardless of which serverless instance handles it, so a count-over-a-trailing-window check inside the same atomic function that does the insert (above) needed no new infrastructure — no Redis, no Upstash, nothing beyond the existing database. The cookie-based duplicate guard remains, layered underneath, for the common case (an accidental double-tap) that doesn't need a database round trip to catch.

## Auth

- Supabase Auth, email/password. Server-side identity via `getClaims()` (not `getUser()`/`getSession()`), per current Supabase guidance.
- `proxy.ts` is protect-by-default: every route not in `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`) requires a session.
- No `user_metadata`/`raw_user_meta_data` is used in any authorization decision (it's user-editable and would be a privilege-escalation hole); the one place it's read (`profiles.full_name` at signup) is display-only, never a security decision.
- Passwords: Supabase's own hashing/storage; the app never sees or logs a plaintext password beyond the single request that submits it.

## Data minimization

The public feedback flow collects no personal data — no email, no name, no device fingerprinting. The duplicate-submission cookie carries no identifying value, just presence. Feedback is private to authenticated members of the owning organization; there is no public read path for feedback content.

## Error handling / logging

Customer-facing errors on the public page are simple and non-technical ("Could not send your feedback. Please try again."). Server-side errors (failed inserts, failed email sends) are still logged via `console.error`/`console.warn` (not deliberately redacted — Vercel's own log retention is short-lived and access is already restricted to the project's team).

**Sentry** (`@sentry/nextjs`) captures errors across client, server, and edge runtimes (`instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`), plus root-layout rendering errors via `app/global-error.tsx`. Every event passes through `lib/sentry-redact.ts`'s `beforeSend` hook first, per the product skill's "avoid logging raw sensitive feedback unnecessarily":
- `event.request.data` is **dropped entirely**, not redacted in place — its shape is `unknown` and unpredictable (it could be a raw string, an array, or an object using field names this app has never heard of), so the only actually-safe handling is not attempting to selectively keep parts of it.
- `extra`/`contexts`/breadcrumb `data` are redacted key-by-key (`feedback_text`/`internal_note`, camelCase included) via a cycle-safe recursive walk (a path-scoped `Set`, not a whole-tree one, so sibling branches sharing a common object don't leak into each other or falsely flag as circular) that also recognizes a sensitive field hidden inside a `JSON.stringify`'d string, not just a plain object key.
- An earlier version of this redaction had four confirmed bugs — trusted the original object shape too much (`request.data` redacted in place, not dropped, so any field it didn't recognize passed through untouched), missed JSON-stringified content, and a circular reference returned the *original*, unredacted object through the back-reference rather than a placeholder (the previous test suite asserted this as correct behavior). Fixed and covered by 22 canary-based unit tests in `lib/sentry-redact.test.ts` that assert against the fully serialized event output, not just specific object keys — including the circular-reference case, corrected to assert the back-reference is `"[circular]"`, never the original object.

The Sentry DSN (`NEXT_PUBLIC_SENTRY_DSN`) is intentionally public — a DSN only lets a client *report* events, not read them, which is why Sentry's own docs embed it directly in client-side code.

## Redirect safety

`signInAction` (`features/auth/actions.ts`) and `app/auth/confirm/route.ts` both accept a `next` query/form parameter naming where to send the user after signing in — an open-redirect surface if not validated, since an attacker can craft a link through this app's own trusted domain that ends somewhere else entirely (a convincing phishing vector: the URL bar shows this app's real domain up until the redirect fires). A naive check (`next.startsWith("/") && !next.startsWith("//")`) is not sufficient: WHATWG URL parsing (what a real browser uses to resolve a redirect) treats a backslash the same as a forward slash for `http`/`https`, so `/\evil.example.com` passes that check yet a browser resolves it identically to `//evil.example.com` — an external, protocol-relative URL. Both call sites use one shared helper (`lib/safe-redirect.ts`) that parses the candidate against the app's own trusted origin and requires the *parsed* result's origin to match exactly, rather than pattern-matching the raw string. 29 unit tests (`lib/safe-redirect.test.ts`) plus a Playwright suite (`e2e/redirect-safety.spec.ts`) drive the real login and email-confirmation flows against the backslash bypass and confirm the actual browser navigation lands safely.

## Onboarding integrity

`createOrganizationAction` used to perform two separate admin-client inserts (organization, then membership) with no transaction across them — a failure between the two could leave an ownerless, permanently inaccessible organization behind, and nothing stopped a double-submit from creating two organizations for the same user. Rewritten as `create_organization_atomic` (`DATABASE_SCHEMA.md` § "Database functions callable as RPCs"): atomic (both inserts share the function's implicit transaction), idempotent (a user who already has an organization gets it back rather than a second one), and serialized per user via an advisory lock so two near-simultaneous calls can't both pass the "no existing org" check before either commits.

## Tenant-isolation test coverage

Beyond RLS policies themselves, `e2e/tenant-isolation.spec.ts` runs against the isolated test project with two real organizations and two real signed-in users, and asserts — through each user's own RLS-bound client, not the admin client, which bypasses RLS and would prove nothing — that Org A cannot read Org B's organization/locations/nfc_cards/feedback/membership rows, cannot update Org B's feedback or nfc_cards (zero rows affected, not an error, and Org B's data is confirmed unchanged afterward), cannot insert directly into Org B's locations/nfc_cards, and never sees Org B's data rendered in its own dashboard. Combined with the per-file RLS coverage in `e2e/feedback-and-card-integrity.spec.ts` (column-level restrictions, finding #3/#4 above) and the Review-Gating Regression Test in `e2e/review-gating.spec.ts` (the Google Review CTA must be identical across all five ratings — the product's one non-negotiable rule), this is the automated form of the Security Checklist's "verify cross-tenant reads fail" / "verify cross-tenant mutations fail" steps, not just a one-time manual check.

## Dependency hygiene

Versions pinned in `package.json`/`package-lock.json`, committed. No dependency has been added without a clear product need.
