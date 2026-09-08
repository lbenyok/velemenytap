import "server-only";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { PLAN_PRICING, type BillingInterval } from "@/features/billing/plans";

/**
 * Second independent review, Finding 6; fourth independent review,
 * Finding 6 (the same finding, sharper): the billing page hardcodes
 * 5,990 Ft / 59,900 Ft while trusting whatever Price ID environment
 * variables happen to be set -- a swapped, stale, or wrong-mode Price ID
 * would silently charge something different from what the page promises,
 * without this app ever noticing.
 *
 * The fourth review found the original "only enforce for APP_ENV exactly
 * production/preview, otherwise skip" design FAILED OPEN: a missing,
 * empty, or misspelled APP_ENV value in a genuinely deployed runtime
 * (Vercel forgot to set it, a typo in the dashboard, a build config
 * regression) skipped mode enforcement entirely, letting Checkout and
 * webhook processing proceed without ever checking test/live mode
 * agreement. Fixed by inverting the logic: `resolveExpectedLivemode()`
 * treats "genuine local development" (NODE_ENV === "development", the
 * same signal /api/health already uses as the one legitimate exemption)
 * as the ONLY case that skips enforcement -- every other runtime
 * (anything built/deployed, `next build`/`next start`/a real Vercel
 * build) MUST resolve APP_ENV to exactly "production" or "preview" or
 * this throws, failing closed rather than silently proceeding unchecked.
 */
export type ExpectedLivemode = { expected: boolean; isLocalDev: false } | { expected: null; isLocalDev: true };

export function resolveExpectedLivemode(): ExpectedLivemode {
  if (process.env.NODE_ENV === "development") {
    return { expected: null, isLocalDev: true };
  }
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production") return { expected: true, isLocalDev: false };
  if (appEnv === "preview") return { expected: false, isLocalDev: false };
  throw new Error(
    `This is a deployed (non-development) runtime but APP_ENV is ${appEnv === undefined ? "unset" : JSON.stringify(appEnv)} ` +
      '-- expected exactly "production" or "preview". Refusing to process Stripe billing without a known environment ' +
      "identity (fail closed) -- see DEPLOYMENT.md.",
  );
}

/**
 * Memoized per server process (a live Stripe API call on every Checkout
 * attempt would be wasteful for something that only needs to catch a
 * genuine misconfiguration, which doesn't change between requests) --
 * re-attempted on the NEXT call if validation itself failed, rather than
 * caching a transient failure (a momentary Stripe API outage, or a
 * missing-APP_ENV condition a redeploy will fix) forever.
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

/**
 * The set of Price ids this app will ever treat as a genuine VéleményTap
 * subscription -- used by features/billing/reconcile.ts to exclude a
 * Stripe subscription attached to some other Product/Price on the same
 * Customer (Finding 11) from ever establishing entitlement. Pure env-var
 * lookup, no Stripe API call -- safe to call on every reconciliation, not
 * just memoized validation.
 */
export function approvedPriceIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const interval of Object.keys(PLAN_PRICING) as BillingInterval[]) {
    const id = process.env[PLAN_PRICING[interval].priceEnvVar];
    if (id) ids.add(id);
  }
  return ids;
}

async function validateNow(): Promise<void> {
  const livemode = resolveExpectedLivemode();
  const expectedLive = livemode.expected;

  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const keyIsLive = isLiveStripeKey(secretKey);
  if (keyIsLive === null) {
    throw new Error(
      "STRIPE_SECRET_KEY does not look like a recognized Stripe secret/restricted key (expected an sk_/rk_ test or live key).",
    );
  }
  if (expectedLive !== null && keyIsLive !== expectedLive) {
    throw new Error(
      `STRIPE_SECRET_KEY is a ${keyIsLive ? "live" : "test"}-mode key, but the runtime expects ` +
        `${expectedLive ? "live" : "test"}-mode.`,
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
        `${envVar} (${price.id}) is ${price.livemode ? "live" : "test"}-mode, but the runtime expects ` +
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
    // Fourth independent review, Finding 13: checking only the interval
    // unit (month/year) permits a Price billed every 3 months or every 2
    // years to pass as an ordinary monthly/yearly plan -- this app's own
    // pricing and copy assume interval_count is always exactly 1.
    if (price.recurring.interval_count !== 1) {
      throw new Error(
        `${envVar} (${price.id}) bills every ${price.recurring.interval_count} ${price.recurring.interval}s, ` +
          `expected every 1 ${price.recurring.interval} -- a multi-period Price is not the plan this app's own copy describes.`,
      );
    }
    // Found live, during this round's real Stripe test-mode verification
    // (not by any unit test -- see stripe-config.test.ts's own comment on
    // its price() helper for why mocks alone could never have caught
    // this): HUF is a normal two-decimal currency for charges on Stripe --
    // confirmed directly against Stripe's own currently-published docs
    // (https://docs.stripe.com/currencies, "Hungarian Forint (HUF) --
    // Stripe treats HUF as a zero-decimal currency for PAYOUTS, even
    // though you can charge two-decimal amounts"). `price.unit_amount` is
    // therefore in fillér (1/100 Ft), exactly like `unit_amount` for USD
    // cents -- a genuine 5 990 Ft Price reports `unit_amount: 599000`, not
    // `5990`. `plan.amountHuf` is deliberately whole Forints (display-only,
    // per plans.ts's own comment) -- comparing it directly against
    // `unit_amount` compared apples to cents and made this check FAIL for
    // every correctly-priced real Stripe Price object, so Checkout has
    // been unconditionally blocked (fail-closed, per this function's own
    // design) any time a Price actually matched what the billing page
    // promises.
    const expectedUnitAmount = plan.amountHuf * 100;
    if (price.unit_amount !== expectedUnitAmount) {
      throw new Error(
        `${envVar} (${price.id}) charges ${price.unit_amount} (minor units) but the billing page promises ` +
          `${plan.amountHuf} Ft (${expectedUnitAmount} minor units).`,
      );
    }
    // The billing page states prices include VAT ("Az árak az ÁFát
    // tartalmazzák"). This checks only that the Price object's OWN
    // tax_behavior field agrees it's tax-inclusive, not exclusive or left
    // ambiguous ("unspecified") -- it is a structural sanity check on the
    // Price configuration, NOT proof that a compliant Hungarian VAT
    // invoice will actually be calculated, collected, and issued for a
    // real purchase. That is a separate, still-open commercial/accounting
    // decision (Stripe Tax, a fixed configured tax rate, or an external
    // Hungarian invoicing provider) -- see DEPLOYMENT.md's "Stripe Tax /
    // Hungarian VAT invoicing" section, which this app's paid-launch
    // readiness is explicitly blocked on until an owner/accountant
    // decision is made.
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
