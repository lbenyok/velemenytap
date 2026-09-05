# Decisions

Assumptions and judgment calls made without a synchronous check-in, per the working-style agreement: proceed autonomously through reasonable implementation decisions, document them here, and only stop and ask when credentials, external account setup, a business/legal choice, or a fundamentally product-changing decision is genuinely required.

## Hungarian localization: in-place translation, not an i18n framework

The full UI (public feedback flow, auth, dashboard, email alerts) is Hungarian by directly replacing English strings, not via `next-intl` or similar with language files and a switchable locale.
**Why:** the explicit request was "make the whole system Hungarian," not "support both languages" — no toggle or English fallback was asked for. Adding an i18n framework for a single fixed language would be exactly the premature abstraction the product skill warns against; it's straightforward to introduce later if English support is ever actually needed, since nothing about in-place strings blocks that migration.
**Revisit if:** the product needs to serve non-Hungarian-speaking businesses too.

## Supabase Auth's own error messages get a translation lookup, not raw passthrough

`features/auth/actions.ts`'s `translateAuthError()` maps the handful of Supabase SDK error strings the app actually surfaces (invalid credentials, already-registered, etc.) to Hungarian, falling back to a generic message for anything unmapped.
**Why:** Supabase Auth returns error messages in English with no localization option; showing that raw text on an otherwise fully-Hungarian sign-in form would be a jarring, obviously-untranslated seam. A small lookup table for the errors users actually hit is cheap and covers the real cases; the generic fallback means an unmapped Supabase error still degrades to Hungarian rather than leaking English.

## Developer-facing log messages (`console.warn`/`console.error`) stay in English

Server-side log lines like "Failed to send negative feedback alert email" were not translated, even though everything a business owner or customer actually sees was.
**Why:** these are read by whoever maintains the code (server logs, Vercel dashboard), not by end users — translating them would add no value for a Hungarian business owner (who never sees a server log) and would work against future maintainers/AI assistants who default to English technical conventions.

## Rebrand: navy/blue/cyan from the actual logo, replacing the invented wine/gold palette

The `--pf-*` CSS custom properties (shared by the public feedback page and the homepage) were repointed from an invented "wine and gold, warm hospitality" palette to navy ink + a blue-to-cyan gradient, matching the user-supplied logo and app icon exactly. Renamed `--pf-wine`/`--pf-wine-hover`/`--pf-gold` to `--pf-accent`/`--pf-accent-hover`/`--pf-accent-2` throughout, since the old names became actively misleading once they held blue/cyan values.
**Why:** the original wine/gold direction was a reasonable choice when no brand assets existed yet, but a real logo/icon was later provided — matching it exactly is strictly better than an invented palette once one exists, and using it is what was explicitly asked for.

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

## Cookie-based duplicate-submission guard, plus a database-backed rate limit (not Redis)

**Superseded in part** by the 2026-09-04 review-response pass — see `SECURITY.md` § "Rate limiting: database-backed, not Redis" for the current, accurate state. The cookie-based guard below is still exactly as originally decided; what changed is that "no rate limiting at all" turned out to be the wrong call, not "no *Redis* rate limiting."

Original reasoning, still valid for the cookie half: Vercel's serverless model makes an in-process limiter unreliable without new infrastructure, which isn't justified before an observed abuse problem; a short-lived, card-scoped, `HttpOnly` cookie solves the actual common case (accidental double-tap) with zero new infrastructure and no personal data collected. What the original reasoning got wrong: it treated "no in-process limiter" and "no rate limiting" as the same conclusion, when Postgres — already the shared state every request goes through regardless of serverless instance — could enforce a count-over-a-trailing-window check with zero new infrastructure, inside the same atomic function (`submit_feedback_atomic`) that already needed to do the insert. An independent review flagged the resulting gap (unbounded scripted flood, and a related email-amplification risk since each qualifying submission sends a real alert email) as finding #2; both are now fixed at the database layer.
**Revisit if:** the 20-per-5-minutes threshold turns out too strict for a real high-traffic location, or too loose against real observed abuse — it's a plain constant in the migration, easy to retune without an architecture change.

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

## e2e tests now run against a dedicated isolated Supabase project

**Superseded** by the 2026-09-04 review-response pass. The reasoning below explains why this was originally accepted and is kept for that context; it is no longer the current state — see `e2e/README.md` for how tests are configured today.

Original decision: `e2e/review-gating.spec.ts` hit the same Supabase project used for local dev and production — there was no `supabase start` (Docker-based local Postgres/Auth) stack for tests to run against instead.
**Why it was accepted then:** this project had never had local-Postgres infrastructure at any point (every migration was pushed directly via `supabase db push --db-url` against the linked hosted project), so a Docker-based local stack would have been genuinely new infrastructure, not a variation on an existing pattern — and it couldn't be verified in the environment this was built in (no Docker available there either). There were no real customers on the product yet, so the blast radius was accepted as low.

**What changed:** an independent review treated "tests run against production" as a real, current risk regardless of whether customers exist yet — correctly; "no customers yet" bounds the blast radius of a mistake, it doesn't make writing test data into the production database intentional or reviewed. The task required an isolated database for its own DB-touching fixes, which forced the actual resolution: a new, dedicated, free-tier Supabase project (URL/keys in `.env.test.local`, gitignored), with `e2e/support/env.ts` preferring it over `.env.local` and `playwright.config.ts` injecting its values into the spawned dev/start server's environment so the app under test talks to it too, not just the Node-side test helpers. Docker remained unavailable throughout, so this is still not a local stack — but it is now a genuinely separate project, not the production one.
**Still open:** CI's e2e job secrets need updating to the isolated project's values if they were ever set from `.env.local` — see `STATUS.md`'s "What's needed from the user."

## Analytics row-cap fix: page-by-page fetching, not SQL-side aggregation

**Superseded** by the round-2 review response — see `SECURITY.md` § "Analytics correctness" and `DATABASE_SCHEMA.md` § "Database functions callable as RPCs" for the current state (SQL-side aggregation, exactly what this entry originally declined to build). Kept below for the original reasoning and why it changed.

An independent review's finding #7 flagged that `getOverviewStats`/`getAnalyticsData` computed all-time/period stats by fetching feedback rows into Node and reducing them there — and that PostgREST's `max_rows` cap (1000, `supabase/config.toml`) silently truncated any single request past that, which was confirmed empirically (1200 seeded rows, `.limit(5000)` requested, 1000 returned). The review's suggested fix was tenant-scoped SQL aggregate functions/views, which would sidestep the cap entirely.
**What was built instead (round 1):** `features/analytics/fetch-all-rows.ts` fetched page by page (parallel requests past the first) until a `MAX_ROWS = 5000` ceiling, leaving `aggregate.ts`'s existing pure, already-unit-tested reduction functions untouched.
**Why it seemed right at the time:** fully closed the *reported* correctness bug (no more silent truncation at 1000 rows) with a much smaller, lower-risk change — no new migration, no new RPC/view surface to keep in sync with `aggregate.ts`'s several different breakdowns. Per the product skill's own "avoid unnecessary infrastructure" and "do not build a full BI platform during MVP," proportionality mattered: the *reported* bug was about correctness at the 1000-row cap specifically, not performance, and page-by-page fetching was correct up to the new 5000-row ceiling.
**What changed:** a round-2 review (R2-02) correctly pointed out that 5000 was itself still a silent correctness ceiling — the same class of bug at a higher threshold, not a different class of problem the original fix didn't need to consider. Separately (R2-03), `OFFSET`-based pagination turned out to not be consistent under concurrent writes at all — a property page-by-page fetching never actually had, previously undetected because nothing had tested it under concurrency. Both findings together meant the original "smaller, lower-risk change" framing was wrong on its own terms: a bounded-but-still-silently-truncating ceiling plus a pagination-consistency bug is not actually lower-risk than the SQL aggregation the first review already suggested. Built this round: `get_feedback_overview_snapshot`/`get_feedback_period_analytics`, computing every statistic inside one tenant-scoped SQL function call per page — no row-count ceiling, one consistent MVCC snapshot per call.
**Lesson, not just an outcome:** proportionality reasoning is only as good as its list of what the smaller fix doesn't need to consider — this is worth re-checking explicitly (not just re-asserting the original conclusion) whenever a later review specifically challenges the boundary a "smaller fix" was scoped to.

## `create_organization_atomic` as `SECURITY DEFINER`, not another admin-client insert

Finding #8 (onboarding non-atomicity/non-idempotency) could have been fixed by keeping the admin-client architecture and just wrapping the existing two inserts more carefully (e.g. a compensating-transaction pattern, or moving both inserts behind a single admin-client RPC call to a `SECURITY INVOKER` function run as `service_role`). Instead, `create_organization_atomic` is `SECURITY DEFINER`, callable directly by the authenticated user's own session — the only genuinely `SECURITY DEFINER` function in this schema.
**Why:** the actual race (finding #8's per-user serialization requirement) needs the check-existing-org-then-insert sequence to happen atomically from the *caller's own identity* (`auth.uid()`), which only makes sense evaluated as that specific user — routing it through the admin client would mean either trusting a user-supplied user ID (a spoofing risk) or adding an extra auth round trip to look up the caller's identity server-side first, for no benefit over letting Postgres read `auth.uid()` directly from the RPC caller's own JWT. `DEFINER` here is the standard, narrowly-scoped pattern for "let an authenticated user perform one specific privileged action that RLS structurally can't authorize," with the mitigations documented in `SECURITY.md`.

## R2-08: server-owned cooldown and an org-level budget; R3-03 completed recipient verification

Round 2 finding R2-08 flagged three things about the negative-feedback alert's abuse controls: the cooldown state was tenant-writable (a plain column an org member's own session could reset via a direct `UPDATE`), the per-card rate limit didn't bound total email volume across an org's cards, and `notification_email` accepts any syntactically-valid address with no verification that the org actually controls it. The first two were fixed completely in round 2: `last_negative_alert_at` can only be changed by `claim_negative_alert_send()` (a trigger rejects every other caller, including the admin client itself), and that same function enforces an organization-wide hourly budget independent of which card a submission came from.

**Round 2 explicitly deferred the third piece** (recipient verification), reasoning that the only complete fix was a real email-confirmation flow, and that the org-wide budget was a real, meaningful (though partial) mitigation in the meantime. A domain-matching heuristic was considered and rejected — actively wrong for this product's real usage pattern (small business owners routinely sign up with a personal Gmail address while wanting alerts routed to a business address on a different domain).

**Round 3 (finding R3-03) built the confirmation flow this entry originally deferred**, since a second independent review pushed back on treating the budget alone as sufficient: `request_notification_email_change()`/`confirm_notification_email_change()` (`DATABASE_SCHEMA.md`) — a candidate address is stored as PENDING alongside a hashed, expiring, single-use token; the active `notification_email` (what alerts actually go to) is untouched until the token is confirmed by visiting a link sent to the candidate address itself. Requesting a new address always overwrites any prior pending request outright — no history of abandoned requests is kept, since the only thing that matters is the current pending token's validity. Clearing the address needs no verification (removing a recipient can't be abused to send email anywhere). The same class of "RLS is row-level, not column-level" gap R2-08 already fixed for the cooldown column applies here too — a trigger (`private.prevent_direct_notification_email_change`) rejects any direct write to the four notification-email columns from any caller but the three functions above, closing the specific hole where a member could otherwise set the pending token hash to one they chose themselves and "confirm" an address without ever proving inbox possession.

**Why this wasn't built in round 2 despite being clearly the complete fix:** proportionality under the original task's own framing — treating a full confirmation flow (new columns, a new public route, new Resend copy, new pending-state UI, an enforcement trigger with its own deploy-ordering hazard) as disproportionate to fold into a pass whose stated scope was fixing a set of already-identified security findings, versus shipping the cheaper, still-meaningful budget mitigation and flagging the gap explicitly for a follow-up. That judgment call was revisited, not reversed on new information: R3-03 concluded the deferral itself was the wrong call for a public-facing spam-relay vector, not that the original reasoning about relative cost was inaccurate.
**Revisit when:** nothing further — this is now the intended long-term state, not a stepping stone.

## Documentation suite lives in `veleminytap/`, not the outer repo root

The git repository root (`.../Biznisz`) also contains unrelated files (design assets, `.claude/` skill config). All product/engineering docs (`README.md`, `PRODUCT_SPEC.md`, etc.) live inside `veleminytap/`, alongside the app they describe and its pre-existing `README.md`/`AGENTS.md`.
**Why:** a reader exploring the actual product would open the `veleminytap/` directory, not the outer scratch folder; co-locating docs with the code they describe is the more discoverable and more conventional choice.

## Billing: one flat plan, a 14-day no-card trial, dashboard-only paywall

Three related choices made together when Stripe subscriptions were built: (1) a single flat plan, unlimited locations/cards, offered at two billing cadences (5 990 Ft/hó, or 59 900 Ft/év — roughly 2 months free versus paying monthly, a standard annual-discount shape) rather than usage-based tiers; (2) every organization gets a 14-day trial with no card required at signup, rather than requiring payment details up front; (3) the paywall (`app/dashboard/layout.tsx`) blocks only the operator dashboard — never the public NFC landing page or feedback submission, regardless of an organization's billing status.
**Why (1):** per the product skill's MVP guidance against premature tiering — there's no usage data yet to size tiers against, and `organization_billing`'s schema doesn't assume a plan count of one (`stripe_subscription_id`/`status` are plan-agnostic), so adding tiers later is additive, not a rework.
**Why (2):** the product's own explicit priority right now is landing its first paying customers (see `STATUS.md`) — requiring a card before a business has seen a single real customer rating land in their dashboard is exactly the kind of friction that costs signups without buying anything in return. A no-card trial removes that friction while still bounding how long access is free.
**Why (3):** a physical NFC card, once sold and placed on a customer's counter, is a promise to that business's own customers that tapping it works — a lapsed subscription must never retroactively break that promise or silently stop collecting real feedback. This is the same shape as the product's non-negotiable Google-Review-non-gating rule (`PRODUCT_SPEC.md`): the public-facing product experience must stay neutral and reliable regardless of an unrelated account-level state. Also directly relevant to how physical cards are sold (see the next entry): a card and a subscription are two independent things a customer can buy, and gating the card on the subscription would break that independence.
**Revisit if:** real usage data shows most organizations only need one location (tiering would be pure complexity) or, conversely, shows enough variance in usage to justify a second tier; or if trial abuse (repeated signups to extend free access) becomes a real problem worth adding friction to prevent.

## Physical NFC cards and the SaaS subscription are sold, and can be used, independently

The dashboard subscription and owning a physical NFC card are deliberately decoupled: an organization can subscribe with zero cards (nothing stops it, nothing requires a card to exist), and — per the entry above — a card keeps working for an unsubscribed organization's existing customers. Physical card fulfillment (inventory, shipping, ordering) is intentionally kept **out of this app**, on a separate storefront (Shopify, on a subdomain of the product's own domain) rather than built as a custom commerce system here.
**Why:** Shopify already solves inventory/shipping/tax well; rebuilding that inside this app to unify it with Stripe subscription billing would be substantial scope for a problem already solved. Keeping the two systems separate (one for physical goods, one for the recurring SaaS charge) is simpler to build and reason about than a merged commerce system, and matches the actual sales model: a card and a subscription are two different purchases a customer can make in either order, or only one at all.
**Not yet built:** a "claim" flow (pre-provisioned card inventory + connecting a physically-bought card to a dashboard organization after the fact) — today a card only exists once created inside a signed-in dashboard. Needed once card fulfillment actually depends on it; tracked as a follow-up, not started.
**Revisit if:** Shopify's fees or limitations become a real problem, or once card fulfillment volume justifies the cost of a fully custom storefront.

## Stripe Checkout and the Billing Portal, not a custom card form

Subscribing and managing billing both redirect to Stripe-hosted pages (`features/billing/actions.ts`) rather than collecting card details in this app's own UI via Stripe Elements.
**Why:** this app never needs to be PCI-compliant itself, never handles a raw card number even transiently, and gets a polished, trustworthy-looking payment page for free — a meaningful advantage for a small business's very first paying customers, versus building and maintaining a custom form for the same underlying Stripe integration. The Billing Portal likewise means cancellation, card updates, and invoice history need zero custom UI.
**Revisit if:** the product ever needs a checkout flow Stripe's hosted pages can't express (e.g. deeply custom branding requirements beyond what Checkout's branding settings allow).
