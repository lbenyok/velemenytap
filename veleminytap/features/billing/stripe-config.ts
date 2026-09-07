import "server-only";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { PLAN_PRICING, type BillingInterval } from "@/features/billing/plans";

/**
 * Second independent review, Finding 6: the billing page hardcodes 5,990
 * Ft / 59,900 Ft while trusting whatever Price ID environment variables
 * happen to be set -- a swapped, stale, or wrong-mode Price ID would
 * silently charge something different from what the page promises,
 * without this app ever noticing. Validates the actual live Stripe
 * configuration against every promise the product makes about it:
 * environment/mode agreement, active status, currency, amount, recurrence
 * interval, tax treatment, and that both cadences genuinely belong to the
 * same Product (see features/billing/plans.ts's own "one product, two
 * cadences" comment).
 *
 * Memoized per server process (a live Stripe API call on every Checkout
 * attempt would be wasteful for something that only needs to catch a
 * genuine misconfiguration, which doesn't change between requests) --
 * re-attempted on the NEXT call if validation itself failed, rather than
 * caching a transient failure (a momentary Stripe API outage) forever.
 */
let cached: Promise<void> | null = null;

export function assertStripeConfigurationValid(): Promise<void> {
  if (!cached) {
    cached = validateNow().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Exposed for tests only -- forces the next call to re-validate. */
export function resetStripeConfigurationCacheForTests(): void {
  cached = null;
}

function isLiveStripeKey(key: string): boolean | null {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return true;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return false;
  return null;
}

function productIdOf(product: Stripe.Price["product"]): string | null {
  if (typeof product === "string") return product;
  if (product && "id" in product) return product.id;
  return null;
}

async function validateNow(): Promise<void> {
  // Only production/preview carry a meaningful expected Stripe mode --
  // matches /api/health's and the webhook's own treatment of "unset" as
  // the expected local-dev case, where no real Stripe traffic flows.
  const appEnv = process.env.APP_ENV;
  const expectedLive = appEnv === "production" ? true : appEnv === "preview" ? false : null;

  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const keyIsLive = isLiveStripeKey(secretKey);
  if (keyIsLive === null) {
    throw new Error(
      "STRIPE_SECRET_KEY does not look like a recognized Stripe secret/restricted key (expected an sk_/rk_ test or live key).",
    );
  }
  if (expectedLive !== null && keyIsLive !== expectedLive) {
    throw new Error(
      `STRIPE_SECRET_KEY is a ${keyIsLive ? "live" : "test"}-mode key, but APP_ENV is "${appEnv}" ` +
        `(expected a ${expectedLive ? "live" : "test"}-mode key).`,
    );
  }

  const stripe = createStripeClient();
  const intervals = Object.keys(PLAN_PRICING) as BillingInterval[];
  const resolved = await Promise.all(
    intervals.map(async (interval) => {
      const envVar = PLAN_PRICING[interval].priceEnvVar;
      const priceId = process.env[envVar];
      if (!priceId) {
        throw new Error(`${envVar} is not set.`);
      }
      const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
      return { interval, envVar, price };
    }),
  );

  for (const { interval, envVar, price } of resolved) {
    const plan = PLAN_PRICING[interval];

    if (expectedLive !== null && price.livemode !== expectedLive) {
      throw new Error(
        `${envVar} (${price.id}) is ${price.livemode ? "live" : "test"}-mode, but APP_ENV "${appEnv}" expects ` +
          `${expectedLive ? "live" : "test"}-mode.`,
      );
    }
    if (!price.active) {
      throw new Error(`${envVar} (${price.id}) is not active on Stripe.`);
    }
    if (price.currency !== "huf") {
      throw new Error(`${envVar} (${price.id}) currency is "${price.currency}", expected "huf".`);
    }
    if (price.type !== "recurring" || !price.recurring) {
      throw new Error(`${envVar} (${price.id}) is not a recurring price.`);
    }
    const expectedRecurrence = interval === "monthly" ? "month" : "year";
    if (price.recurring.interval !== expectedRecurrence) {
      throw new Error(
        `${envVar} (${price.id}) recurs "${price.recurring.interval}", expected "${expectedRecurrence}".`,
      );
    }
    if (price.unit_amount !== plan.amountHuf) {
      throw new Error(
        `${envVar} (${price.id}) charges ${price.unit_amount} but the billing page promises ${plan.amountHuf} Ft.`,
      );
    }
    // The billing page states prices include VAT ("Az árak az ÁFát
    // tartalmazzák") -- the Price object must agree explicitly, not leave
    // tax treatment ambiguous (Stripe's "unspecified").
    if (price.tax_behavior !== "inclusive") {
      throw new Error(
        `${envVar} (${price.id}) has tax_behavior "${price.tax_behavior}", expected "inclusive" to match the ` +
          'billing page\'s "árak az ÁFát tartalmazzák" copy.',
      );
    }
  }

  const productIds = new Set(resolved.map(({ price }) => productIdOf(price.product)));
  if (productIds.size !== 1 || productIds.has(null)) {
    throw new Error(
      "The monthly and yearly Price IDs do not both resolve to the same Stripe Product (or a product is missing/deleted) -- expected one product, two billing cadences.",
    );
  }
}
