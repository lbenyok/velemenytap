import "server-only";

import Stripe from "stripe";

/**
 * Fourth independent review, Finding 9: the Checkout-attempt claim window
 * was justified only by comparing it against the Stripe SDK's own
 * *default* 80-second request timeout -- but with no explicit timeout/
 * retry configuration, the SDK's automatic network-retry behavior (or a
 * genuinely slow request) could make a single logical Stripe call take
 * meaningfully longer than that default alone suggests, and a checkout
 * attempt makes at least two sequential calls (resolving/creating the
 * Stripe Customer, then creating the Checkout Session). An explicit,
 * bounded budget here is the other half of Finding 9's fix -- the other
 * half is features/billing/actions.ts renewing its own claimed attempt at
 * the checkpoint right before the slowest remaining call, so correctness
 * does not depend on any single static claim duration being provably
 * longer than the worst case of every Stripe call combined.
 *
 * `timeout: 20_000` bounds a single HTTP attempt; `maxNetworkRetries: 2`
 * lets the SDK retry a genuinely idempotent request (network-level
 * failures only, and only for requests carrying an idempotency key) with
 * its own built-in exponential backoff -- worst case, one logical call
 * can still take a multiple of the single-attempt timeout, which is
 * exactly why callers must never treat "under 80 seconds" as a safe
 * assumption on its own.
 */
export function createStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
}
