import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Second independent review, Finding 6: the billing page hardcodes 5,990
 * Ft / 59,900 Ft while trusting whatever Price ID environment variables
 * happen to be set. These tests cover assertStripeConfigurationValid's own
 * validation logic directly, mocking Stripe's Price API -- see
 * features/billing/actions.test.ts for how this is invoked (and mocked
 * away as a no-op) from the actual checkout flow.
 */

vi.mock("server-only", () => ({}));

const pricesRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  createStripeClient: () => ({ prices: { retrieve: pricesRetrieve } }),
}));

const MONTHLY_PRICE_ID = "price_monthly";
const YEARLY_PRICE_ID = "price_yearly";

function price(overrides: Partial<{
  id: string;
  livemode: boolean;
  active: boolean;
  currency: string;
  type: string;
  recurring: { interval: string } | null;
  unit_amount: number;
  tax_behavior: string;
  product: string | { id: string };
}> = {}) {
  return {
    id: MONTHLY_PRICE_ID,
    // Matches beforeEach's default scenario (APP_ENV=production, a
    // sk_live_ key) -- tests exercising the preview/test-mode scenario
    // override this explicitly.
    livemode: true,
    active: true,
    currency: "huf",
    type: "recurring",
    recurring: { interval: "month" },
    unit_amount: 5990,
    tax_behavior: "inclusive",
    product: "prod_shared",
    ...overrides,
  };
}

function monthlyOk() {
  return price({ id: MONTHLY_PRICE_ID, recurring: { interval: "month" }, unit_amount: 5990 });
}
function yearlyOk() {
  return price({ id: YEARLY_PRICE_ID, recurring: { interval: "year" }, unit_amount: 59900 });
}

async function importFresh() {
  vi.resetModules();
  return import("./stripe-config");
}

describe("assertStripeConfigurationValid", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.APP_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    process.env.STRIPE_PRICE_ID_MONTHLY = MONTHLY_PRICE_ID;
    process.env.STRIPE_PRICE_ID_YEARLY = YEARLY_PRICE_ID;
    pricesRetrieve.mockImplementation(async (id: string) => (id === MONTHLY_PRICE_ID ? monthlyOk() : yearlyOk()));
  });

  it("passes for a fully consistent live-mode production configuration", async () => {
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
  });

  it("passes for a fully consistent test-mode preview configuration", async () => {
    process.env.APP_ENV = "preview";
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), livemode: false }) : price({ ...yearlyOk(), livemode: false }),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
  });

  it("does not gate on livemode at all when APP_ENV is unset (local development), but still validates everything else", async () => {
    delete process.env.APP_ENV;
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
  });

  it("rejects a STRIPE_SECRET_KEY that doesn't look like a Stripe key at all", async () => {
    process.env.STRIPE_SECRET_KEY = "not-a-real-key";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/does not look like a recognized Stripe/);
  });

  it("rejects a TEST-mode key when APP_ENV is production", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/test-mode key, but APP_ENV is "production"/);
  });

  it("rejects a LIVE-mode key when APP_ENV is preview", async () => {
    process.env.APP_ENV = "preview";
    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/live-mode key, but APP_ENV is "preview"/);
  });

  it("rejects a missing Price ID environment variable", async () => {
    delete process.env.STRIPE_PRICE_ID_YEARLY;
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/STRIPE_PRICE_ID_YEARLY is not set/);
  });

  it("rejects a price whose livemode disagrees with APP_ENV", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), livemode: false }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/is test-mode, but APP_ENV "production" expects live-mode/);
  });

  it("rejects an inactive price", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), active: false }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/is not active on Stripe/);
  });

  it("rejects a non-HUF currency", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), currency: "usd" }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/currency is "usd", expected "huf"/);
  });

  it("rejects a one-time (non-recurring) price", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), type: "one_time", recurring: null }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/is not a recurring price/);
  });

  it("rejects the monthly price recurring yearly (and vice versa)", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), recurring: { interval: "year" } }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/recurs "year", expected "month"/);
  });

  it("rejects an amount that doesn't match the billing page's promised price", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), unit_amount: 4990 }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/charges 4990 but the billing page promises 5990/);
  });

  it("rejects a price whose tax_behavior is not explicitly 'inclusive'", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), tax_behavior: "unspecified" }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/tax_behavior "unspecified", expected "inclusive"/);
  });

  it("rejects monthly and yearly prices that belong to DIFFERENT Stripe Products", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), product: "prod_a" }) : price({ ...yearlyOk(), product: "prod_b" }),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/do not both resolve to the same Stripe Product/);
  });

  it("accepts an expanded product object, not just a bare product id string", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID
        ? price({ ...monthlyOk(), product: { id: "prod_shared" } })
        : price({ ...yearlyOk(), product: { id: "prod_shared" } }),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
  });

  it("memoizes a successful validation -- a second call does not hit Stripe again", async () => {
    const { assertStripeConfigurationValid } = await importFresh();
    await assertStripeConfigurationValid();
    await assertStripeConfigurationValid();
    expect(pricesRetrieve).toHaveBeenCalledTimes(2); // once per interval, not twice per interval
  });

  it("does not cache a failed validation -- a subsequent call automatically re-attempts it", async () => {
    pricesRetrieve.mockRejectedValueOnce(new Error("Stripe is down"));
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/Stripe is down/);
    // The mock now resolves normally (the transient failure is over) --
    // the SAME module instance's next call must retry, not keep replaying
    // the cached rejection.
    pricesRetrieve.mockImplementation(async (id: string) => (id === MONTHLY_PRICE_ID ? monthlyOk() : yearlyOk()));
    await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
  });
});
