import "server-only";

import Stripe from "stripe";

/**
 * Server-only Stripe client. Never import from a Client Component -- the
 * secret key must never reach the browser bundle.
 */
export function createStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!);
}
