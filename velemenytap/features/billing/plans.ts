export type BillingInterval = "monthly" | "yearly";

export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "yearly"];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}

/**
 * One product, two billing cadences -- not two plans with different
 * features. `priceEnvVar` names the Stripe Price object id env var for
 * each (two separate Prices under the same Stripe Product, set up in the
 * Stripe dashboard); `amountHuf` is display-only, read by the billing page,
 * never sent to Stripe -- Stripe's own Price object is the actual source
 * of truth for what gets charged.
 */
export const PLAN_PRICING: Record<
  BillingInterval,
  { amountHuf: number; label: string; cadence: string; priceEnvVar: "STRIPE_PRICE_ID_MONTHLY" | "STRIPE_PRICE_ID_YEARLY" }
> = {
  monthly: { amountHuf: 5990, label: "Havi", cadence: "hó", priceEnvVar: "STRIPE_PRICE_ID_MONTHLY" },
  yearly: { amountHuf: 59900, label: "Éves", cadence: "év", priceEnvVar: "STRIPE_PRICE_ID_YEARLY" },
};

export function stripePriceId(interval: BillingInterval): string {
  return process.env[PLAN_PRICING[interval].priceEnvVar]!;
}
