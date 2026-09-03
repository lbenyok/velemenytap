# Decisions

Assumptions and judgment calls made without a synchronous check-in, per the working-style agreement: proceed autonomously through reasonable implementation decisions, document them here, and only stop and ask when credentials, external account setup, a business/legal choice, or a fundamentally product-changing decision is genuinely required.

## Single organization per signed-in user

`getCurrentOrganization()` resolves the earliest-joined membership and the dashboard has no org switcher, even though the schema (`organization_memberships`) supports a user belonging to more than one organization.
**Why:** no product requirement yet calls for one user managing multiple businesses, and building a switcher speculatively would be exactly the kind of premature abstraction the product skill warns against.
**Revisit if:** a user needs to manage more than one business — the schema already supports it, so this is additive, not a migration.

## No role-gated dashboard authorization

`organization_memberships.role` supports `owner/admin/manager/staff`, and RLS/dashboard access is uniform across all of them — no feature is currently hidden or restricted by role.
**Why:** there is no invite flow, so no membership other than `owner` (the signup-time creator) can ever actually exist yet. Gating UI or actions by a role that's unreachable would be dead code that's also untestable, and would be inconsistent with the rest of the app's current "any member can act" model.
**Revisit when:** an invite flow ships and `manager`/`staff` memberships become real — at that point, Settings (business profile edits) is the most likely first candidate for an owner/admin-only restriction.

## Organization logo as a pasted URL, not an upload

The Settings page's `logo_url` field is a plain text input validated as an `http(s)://` URL, not a Supabase Storage upload widget.
**Why:** building storage upload UI (bucket policies, signed URLs, image validation, a picker component) is a meaningfully larger scope than the rest of the Settings page for a field with no other consumer yet (nothing in the product currently renders the logo anywhere).
**Revisit when:** something actually displays the logo (e.g. branding the public `/r/{publicId}` page) and self-hosted upload becomes worth the scope.

## `notification_email` overrides member-based alert routing (not additive)

If an organization sets `notification_email`, negative-feedback alerts go there and only there — the owner/admin/manager member lookup is skipped entirely, not supplemented.
**Why:** matches the Settings page's own copy ("Where negative-feedback alerts are sent. Leave blank to notify all team members instead.") and the common real-world case: a business wants alerts routed to one shared inbox (e.g. a manager's email or a shared support address), not fanned out to every account holder.
**Revisit if:** a business wants both a shared inbox and individual member alerts — would need to become an explicit "also notify members" checkbox rather than silent dual-delivery.

## Cookie-based duplicate-submission guard instead of IP/Redis rate limiting

See `SECURITY.md` § "Why no IP-based / Redis-backed rate limiting (yet)" for the full reasoning. Summary: Vercel's serverless model makes an in-process limiter unreliable without new infrastructure, which isn't justified before an observed abuse problem; a short-lived, card-scoped, `HttpOnly` cookie solves the actual common case (accidental double-tap) with zero new infrastructure and no personal data collected.

## Single `internal_note` column, not a `feedback_notes` table

The master build prompt's suggested schema includes a separate `feedback_notes` table (presumably for multiple, attributed, timestamped notes per feedback item). The shipped schema keeps the original single `internal_note text` column on `feedback` instead.
**Why:** the dashboard's actual manager workflow today is one person resolving one item; a single free-text note covers that completely. A separate table (with its own RLS policies, its own UI for a note thread, author attribution) is real added complexity for a capability nothing in the current product asks for — exactly the "complicated CRM workflow" the product skill says to avoid during MVP.
**Revisit when:** more than one team member is realistically working the same feedback item (which itself depends on the invite flow / role-gating above existing first) and a single overwritable note becomes a genuine collaboration gap.

## `priority` as a generated column, not application-computed

`feedback.priority` is `GENERATED ALWAYS AS (...) STORED` from `rating`, rather than computed in TypeScript at read time or written by the application on insert.
**Why:** correctness-by-construction — a generated column cannot drift from the rating that produced it, whereas an app-computed value could (a bug, a bypassed code path, a manual DB edit) silently desynchronize priority from rating. This is a stronger guarantee than the alternative for equivalent effort.

## UTC day boundaries for "today" / "this week"

Overview stats' `today`/`thisWeek` use UTC calendar-day boundaries (matching the existing `dailySeries` aggregation's own UTC-day convention), not a per-organization local timezone.
**Why:** the schema has no per-organization timezone field, and adding one purely to shift a dashboard stat by a few hours is disproportionate for MVP. A single-timezone small business won't notice the skew; this was already the established convention elsewhere in `features/analytics/aggregate.ts` before this decision, so it's consistency, not a new tradeoff.
**Revisit if:** a business spans multiple timezones or complains about the boundary being visibly wrong for their location.

## Sentry source map upload skipped for now

`withSentryConfig` in `next.config.ts` runs with only `{ silent: true }` — no `org`, `project`, or `authToken`. Error capture (client/server/edge) is fully live; stack traces in the Sentry dashboard will show minified production code instead of your original source.
**Why:** wiring up source maps needs a `SENTRY_AUTH_TOKEN`, which is a credential — per the working-style agreement, that's a "stop and ask" item, not an autonomous one, and the DSN alone (no token needed) already delivers the actual point of this round: knowing when something breaks in production.
**Revisit when:** minified stack traces become a real debugging obstacle — at that point, generate a Sentry auth token and add `org`/`project`/`authToken` to the `withSentryConfig` call.

## No Sentry Session Replay or user feedback widget

Only core error monitoring was wired up — not `Sentry.replayIntegration()` or `Sentry.feedbackIntegration()`, both mentioned in Sentry's own quickstart.
**Why:** Session Replay records DOM/screen activity, which is a materially bigger privacy surface than error capture alone (see `SECURITY.md` § Data minimization) and wasn't what was actually asked for — the task was closing the "no error monitoring" gap tracked in `STATUS.md`, not building out a full observability suite. Adding integrations nothing asked for is the kind of speculative scope the product skill warns against.
**Revisit if:** debugging a hard-to-reproduce customer-facing bug genuinely needs session context beyond what an error's stack trace and breadcrumbs already provide.

## e2e tests run against the shared Supabase project, not an isolated local stack

`e2e/review-gating.spec.ts` hits the same Supabase project used for local dev and production — there's no `supabase start` (Docker-based local Postgres/Auth) stack for tests to run against instead.
**Why:** this project has never had local-Postgres infrastructure at any point (every migration so far was pushed directly via `supabase db push --db-url` against the linked hosted project — see `README.md`), so a Docker-based local stack for e2e would be genuinely new infrastructure, not a variation on an existing pattern. It also couldn't be verified in the environment this was built in (no Docker available there). There are no real customers on the product yet, so the blast radius of test data touching this database is low, and the seed/cleanup helpers (`e2e/support/seed.ts`) namespace everything under an `E2E Review Gating {timestamp}` org name and delete it in `afterAll`.
**Revisit when:** real customers are using the product — at that point, tests writing to the same database real customers' data lives in stops being acceptable, and a genuinely isolated Supabase project (or a Docker-based local stack in CI, which GitHub Actions runners support natively) should replace this.

## Documentation suite lives in `veleminytap/`, not the outer repo root

The git repository root (`.../Biznisz`) also contains unrelated files (design assets, `.claude/` skill config). All product/engineering docs (`README.md`, `PRODUCT_SPEC.md`, etc.) live inside `veleminytap/`, alongside the app they describe and its pre-existing `README.md`/`AGENTS.md`.
**Why:** a reader exploring the actual product would open the `veleminytap/` directory, not the outer scratch folder; co-locating docs with the code they describe is the more discoverable and more conventional choice.
