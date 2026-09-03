# Security

## Tenant isolation

This is a multi-tenant SaaS; cross-tenant data leakage is treated as critical severity. The tenant boundary is enforced at the database layer via Postgres RLS (`DATABASE_SCHEMA.md` § Row Level Security), not by application-level filtering — a query that "forgets" a `WHERE organization_id = ...` clause still cannot return another org's rows. Every RLS policy follows `private.is_org_member(organization_id)`, a single `SECURITY DEFINER` helper, so the tenant check is one auditable code path rather than duplicated per policy.

Denormalized `organization_id`/`location_id` columns (kept for RLS/query performance rather than requiring joins) are guarded against drift by trigger functions (`validate_nfc_card_organization`, `validate_feedback_consistency`) that re-derive the true value from the parent row and reject any insert/update where they disagree. `organization_id` itself is immutable post-creation (`prevent_organization_id_change`), closing the specific hole where a user belonging to two orgs could otherwise move a row between them via an `UPDATE`.

## Secrets

- `SUPABASE_SECRET_KEY` is read only in `lib/supabase/admin.ts`, which is guarded by `import "server-only"` — a build-time guarantee it can never enter a client bundle.
- No `NEXT_PUBLIC_*` variable holds a privileged credential; only the Supabase URL and publishable key are exposed to the browser.
- `.env.local` and `.env*.local` are gitignored; `.env.example` documents required variables without values.

## The one deliberate RLS bypass

The admin (secret-key) client is used in exactly two places, both server-only:

1. **Public feedback submission** (`submitFeedbackAction`) — there is no authenticated user on the public NFC page, so `auth.uid()`-based RLS policies have nothing to check against. The action re-validates the NFC card server-side (existence, active status, and re-derives `organization_id`/`location_id` from the card rather than trusting anything the client sent) before the admin-client insert, so the bypass is narrow: one action, one table, fully server-validated shape.
2. **Negative-feedback alert email** — looks up an org's `notification_email` or its owner/admin/manager members' auth emails to send the alert. Read-only, server-only, never returns data to the client.

No other code path uses the admin client. Every dashboard read/write goes through the RLS-bound client (`lib/supabase/server.ts`), scoped to the signed-in user's own session.

## Public endpoint hardening

`submitFeedbackAction` (`features/feedback/actions.ts`):
- zod validation on `public_id` (UUID), `rating` (1–5 int), `feedback_text` (≤ 1000 chars).
- Card existence and active-status re-checked at submission time, not just at page load (a card could be deactivated in the interval).
- Cookie-based duplicate-submission guard (below) — no personal data, opaque marker, card-scoped.

### Why no IP-based / Redis-backed rate limiting (yet)

Deliberately not implemented for MVP. Vercel's serverless functions don't share memory across instances, so an in-process limiter would be unreliable without adding real infrastructure (Redis or equivalent) — not justified before there's a demonstrated abuse problem, per the product skill's "avoid unnecessary infrastructure" guidance. What's implemented instead solves the case that actually matters for NFC in practice: an accidental double-tap or a customer resubmitting the same card a few times in a row. A short-lived (5 minute), `HttpOnly`, `secure`, card-path-scoped cookie (`fb_sent_{publicId}`) blocks that without touching legitimate customers on other cards or other visits, and without any new infrastructure. It is not a defense against a determined scripted attacker (a cookie is trivially not sent); if abuse is observed in production, the next step is a Redis-backed limiter (e.g. Upstash) keyed on `public_id` + a coarse client signal. Tracked as a known gap, not an oversight.

## Auth

- Supabase Auth, email/password. Server-side identity via `getClaims()` (not `getUser()`/`getSession()`), per current Supabase guidance.
- `proxy.ts` is protect-by-default: every route not in `PUBLIC_PATHS` (`/`, `/login`, `/signup`, `/auth`, `/r`) requires a session.
- No `user_metadata`/`raw_user_meta_data` is used in any authorization decision (it's user-editable and would be a privilege-escalation hole); the one place it's read (`profiles.full_name` at signup) is display-only, never a security decision.
- Passwords: Supabase's own hashing/storage; the app never sees or logs a plaintext password beyond the single request that submits it.

## Data minimization

The public feedback flow collects no personal data — no email, no name, no device fingerprinting. The duplicate-submission cookie carries no identifying value, just presence. Feedback is private to authenticated members of the owning organization; there is no public read path for feedback content.

## Error handling / logging

Customer-facing errors on the public page are simple and non-technical ("Could not send your feedback. Please try again."). Server-side errors (failed inserts, failed email sends) are logged via `console.error`/`console.warn` server-side only — feedback content is not deliberately excluded from these logs today (see `STATUS.md` for the Sentry integration, which will need a redaction rule for `feedback_text` before it ships, per the product skill's "avoid logging raw sensitive feedback unnecessarily").

## Dependency hygiene

Versions pinned in `package.json`/`package-lock.json`, committed. No dependency has been added without a clear product need.
