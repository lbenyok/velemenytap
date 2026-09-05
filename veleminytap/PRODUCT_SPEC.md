# Product Spec

## What this is

VéleményTap ("Opinion Tap") is a SaaS product for physical businesses — cafés, salons, clinics, retail, gyms — to collect first-party customer feedback via NFC cards and manage their public reputation. A business places an NFC card at the point of service; a customer taps it, rates the visit, and is offered a Google Review link. The business sees every rating in a dashboard, gets alerted on negative ones, and can track trends across locations and cards over time.

## Core customer flow

1. Customer taps an NFC card (no app, no login).
2. A fast, mobile-first page loads at `/r/{public_id}`, branded with the business name and location.
3. Customer picks 1–5 stars.
4. Customer may add a short written comment (optional).
5. Customer submits. The submission is stored against the business's dashboard.
6. Customer is shown a "Leave a Google review" link, **identically regardless of the rating they gave**.

## The one rule that overrides everything else

**The Google Review CTA is never gated by rating.** All five ratings show the same CTA, in the same place, with the same prominence. Low ratings may trigger internal alerts and dashboard prioritization — they must never reduce or remove the customer's opportunity to leave a public Google review, and negative customers must never be funneled into an internal-only flow while positive customers are routed externally. Every change to the public rating/review flow is re-verified across all five ratings (`TEST_PLAN.md` § Review-Gating Regression Test) before it ships.

## Who uses it

- **Customers** — anonymous, one-time interaction per tap. No account, no email required.
- **Business users** (owner/admin/manager/staff roles in the schema; only "owner" actually exists today — see `DECISIONS.md`) — sign in to a dashboard scoped to their organization, view/filter/resolve feedback, manage locations and NFC cards, view analytics, and configure notification/branding settings.

## Feature areas (MVP, built)

- **Auth & organizations** — email/password signup, one organization per user (org switcher not built), membership-based access.
- **Locations** — name, address, Google Review URL, active/inactive status.
- **NFC cards** — belong to a location, unguessable public UUID identifier, active/inactive status, multiple cards per location (e.g. per table, per counter).
- **Public feedback page** — unauthenticated, validates the card is active before accepting a submission, cookie-based duplicate-tap protection.
- **Feedback inbox** — newest-first, filterable by status/rating/location/NFC card/date range, per-item status (new/in_progress/resolved) and internal note.
- **Negative-feedback email alerts** — ratings ≤ 2 trigger a non-blocking email to the org's notification address (or all owner/admin/manager members if none is configured).
- **Analytics & Overview** — total feedback, average rating, today/this-week counts, unresolved-negative count, rating distribution, recent feedback, volume-over-time and location/card comparisons on the Analytics page.
- **Settings** — business name, notification email, logo URL.
- **Billing** — a single flat subscription, billed monthly (5 990 Ft/hó, ÁFával) or yearly (59 900 Ft/év, ÁFával), Stripe-hosted checkout and billing management. Every organization starts on a 14-day trial requiring no card; the dashboard is inaccessible once the trial lapses without an active subscription — the public NFC/feedback pages are never affected by billing status (see "The one rule that overrides everything else" below, and `DECISIONS.md`).

## Pricing

One plan, two billing cadences — `5 990 Ft/hó` or `59 900 Ft/év` (both ÁFával, the yearly option roughly 2 months cheaper than paying monthly) — covering unlimited locations and NFC cards per organization either way; no usage-based tiers for MVP (see `DECISIONS.md` for why). 14-day trial, no card required to start. Physical NFC cards themselves are sold separately (a different storefront, not this app) — a subscription and card ownership are independent: an organization can subscribe with zero cards, and a card someone bought keeps working even for an organization whose subscription has lapsed.

## Explicitly out of scope for MVP

AI feedback analysis/summarization, tiered/usage-based billing, native mobile apps, enterprise RBAC, an org switcher, automation builders, QR-code generation (lower priority than the core loop — see `DECISIONS.md`).

## Success signal

A business can, within minutes of getting an NFC card: place it, receive a real customer rating, get emailed if it's negative, and see it in their dashboard — without VéleményTap ever standing between a happy customer and their public Google review.
