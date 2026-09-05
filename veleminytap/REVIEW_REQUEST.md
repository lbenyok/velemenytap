# Review Request — Subscription Billing

This is a review request for a new feature, not a response to a prior review round — VéleményTap's first paid-subscription implementation (Stripe). It was built independently of, and in parallel with, the round-4 review-response branch (`fix/round4-review-findings`, still open on [PR #3](https://github.com/lbenyok/velemenytap/pull/3)); this branch was cut from `master` before round 4 merged, so it does not include round 4's fixes. Read this alongside `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, and `DECISIONS.md`, all updated to describe the current, post-billing state.

**Reviewed state:** `master` at commit `443ea98`.
**Branch:** `feature/billing-subscriptions`, based on `443ea98` — **not merged, not deployed to production, migration applied only to the isolated test project** (never production).
**Commit range:** `443ea98..4350f76` (2 commits, 28 files, +1275/-13).

## 1. What this is

Every organization now needs an active subscription (or an unexpired trial) to use the operator dashboard. Product decisions, made explicitly with the user before building (`DECISIONS.md` has the full reasoning for each):

- **One plan, two billing cadences** — 5 990 Ft/hó or 59 900 Ft/év (both VAT-inclusive; the yearly option roughly 2 months cheaper than paying monthly), not usage-based tiers.
- **A 14-day trial, no card required at signup** — every organization gets one automatically the instant it's created.
- **The paywall gates the dashboard only** — never the public NFC landing page or feedback submission. A physical card already sold and sitting on a customer's counter must keep collecting real feedback regardless of its organization's billing status; this is treated as a hard product invariant, the same shape as the existing Google-Review non-gating rule.

## 2. What was built

- **`organization_billing`/`stripe_webhook_events` tables** (migration `20260905125856`), plus a trigger (`private.provision_organization_trial()`) that auto-creates every new organization's trial row atomically with the organization itself. `organization_billing` has a `select` policy for org members but **no `insert`/`update`/`delete` policy for `authenticated` at all** — only the webhook handler and checkout/portal Server Actions, both via the admin client, can write to it.
- **`features/billing/`** — `status.ts` (`isBillingActive()`, the entire access decision, cleanly split by whether a Stripe subscription exists yet: time-based trial check before one does, Stripe's own status trusted directly once one does), `plans.ts` (the two billing intervals, with `isBillingInterval()` validating a submitted form field against an explicit allowlist before it's used to look up an env var), `actions.ts` (Checkout/Billing Portal Server Actions — both redirect to Stripe-hosted pages, this app never handles card data), `queries.ts`.
- **`app/api/webhooks/stripe/route.ts`** — public (Stripe calls it with no session), so its signature check (`stripe.webhooks.constructEvent`) is the actual security boundary, not `proxy.ts`'s auth gate. Idempotent via `stripe_webhook_events` (Stripe documents at-least-once, possibly-duplicate delivery). Maps any subscription status outside the known, exhaustive set to `'incomplete'` rather than crashing on an unrecognized future Stripe status.
- **The paywall itself** (`app/dashboard/layout.tsx`) — protect-by-default, exempting only `/dashboard/billing`, the same philosophy as `proxy.ts`'s own auth gate, so a newly added dashboard page is covered automatically. Needs the current request path to exempt the billing page from its own redirect (avoiding a loop); `proxy.ts` forwards it via an `x-pathname` header (Next.js's documented recipe for this).
- **`app/dashboard/billing/page.tsx`** — the actual payment/plan page: trial countdown, current status, both plan options with a savings badge on the yearly one, subscribe/manage CTAs.

## 3. Verification

```
npm run typecheck        tsc --noEmit          — clean
npm run lint               eslint                  — clean
npm run test                 vitest run              — 120/120 passed (8 files; +23 for this feature:
                                                          isBillingActive, the webhook handler with
                                                          stripe/the admin client mocked, plans.ts's
                                                          interval validation)
npm run build                 next build                 — clean, 20 routes (including /dashboard/billing,
                                                          /api/webhooks/stripe)
```

**Migration applied to the isolated test project** (`npx supabase db push`, run by the user from their own terminal — this sandboxed environment's connection to the test project was intermittent, consistent with earlier rounds' notes) — succeeded cleanly, table/trigger/RLS all created without error.

**A real Stripe Checkout flow was exercised manually** (test mode, a real Stripe account, the user's own browser): both "Előfizetek" buttons correctly redirect to a genuine Stripe-hosted Checkout session for the corresponding price.

`npm run test:e2e` — `e2e/billing-paywall.spec.ts`'s 4 tests pass reliably (verified 3 consecutive runs, no flakiness) as part of the full 16-spec-file suite (79/84 passed; the 5 unrelated failures were an SSL transport hiccup on one Supabase call and auth rate-limiting under the free-tier test project when running the full suite back-to-back — not this PR). The tests cover: a freshly-trialing org can reach the dashboard; a lapsed org is redirected from any `/dashboard/*` route to `/dashboard/billing`; the billing page itself never redirects (no loop); and — the invariant that matters most — public feedback submission through `/r/{publicId}` keeps working, unauthenticated, for an org with an inactive subscription.

**A real bug was found and fixed while writing that first test, worth reading carefully as its own finding:** `signInAction` (`features/auth/actions.ts`) originally redirected unconditionally to `/dashboard`, relying on `app/dashboard/layout.tsx`'s own `redirect()` to bounce an inactive org onward to `/dashboard/billing` on its next render. Two server-side `redirect()`s chained through one Server Action response turned out to be a genuine, 100%-reproducible bug under Turbopack dev-mode streaming — confirmed directly via browser console (`Failed to fetch RSC payload for /dashboard/billing. Falling back to browser navigation`, following a server-side `destination stream closed early` error), producing a real client-side reload loop that never resolved within any reasonable timeout. Fixed by having `signInAction` itself resolve the billing-aware destination and redirect there directly — a single hop, not a chain. The layout's own check remains the actual security boundary for every other dashboard entry point (direct navigation, bookmarks); this fix only changes the *path* taken for the login case, not who enforces the gate.

## 4. Scope notes / what's deliberately not done

- **Not deployed anywhere.** No production migration, no production Stripe configuration, no Vercel environment variables set. Currently runs against test-mode Stripe and the isolated Supabase test project only.
- **No live-mode Stripe testing** — deliberate, per explicit user decision: ship with test-mode Stripe first, defer live-mode setup (a fresh live secret key, live-mode Prices, a registered production webhook endpoint) to a later, separate step.
- **No card-claiming/inventory flow for physical NFC cards sold independently of a subscription** — tracked as a known follow-up in `DECISIONS.md`, not part of this branch. A card only exists once created inside a signed-in, billing-active dashboard today.
- **No self-serve plan switching UI** beyond what Stripe's own Billing Portal provides (canceling, updating card, viewing invoices) — no in-app "switch from monthly to yearly" button; the Portal may or may not support that depending on its Stripe-side configuration, unverified either way.

## 5. Where to be especially critical

1. **`organization_billing`'s RLS and the admin-client-only write path** — confirm there is genuinely no way for an authenticated org member to write to this table directly (no policy at all should mean default-deny, but worth confirming against the actual applied schema, not just the migration file).
2. **The webhook's signature verification and idempotency** — read `app/api/webhooks/stripe/route.ts` directly; confirm every code path that could apply a state change is gated behind both the signature check and the `stripe_webhook_events` insert succeeding.
3. **`isBillingActive()`'s two-path logic** (`features/billing/status.ts`) — confirm the split between "no subscription yet, time-based trial" and "subscription exists, Stripe's status is authoritative" is actually exhaustive and doesn't have a gap where an organization could end up in neither bucket (or both, contradictorily).
4. **The paywall's exemption of exactly one path** (`/dashboard/billing`) via the `x-pathname` header technique — confirm this can't be spoofed or bypassed (e.g. could a client send its own `x-pathname` header to fake being on the billing page?). This is worth a close read of `proxy.ts` and how Next.js actually resolves header precedence between an incoming client header and the one `proxy.ts` sets.
5. **Whether the public/dashboard gating split is actually complete** — confirm no other code path (a Server Action, an API route) enforces or assumes an active subscription in a way that could leak into the public flow, or conversely, whether any dashboard functionality is reachable through a path this review didn't check.
6. **`signInAction`'s duplicated billing check** (§ 3's addendum) — it now resolves the paywall destination itself, alongside the layout's own identical check. Confirm these two checks can't disagree (e.g. a TOCTOU window between the two reads of `organization_billing`, however narrow) and that this duplication doesn't become the thing that drifts out of sync if the gating logic changes later — `isBillingActive()` being the single shared source of truth both call into is what should prevent that, but worth reading both call sites side by side.
