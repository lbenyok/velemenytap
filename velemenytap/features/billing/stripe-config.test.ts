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
  recurring: { interval: string; interval_count: number } | null;
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
    recurring: { interval: "month", interval_count: 1 },
    // In minor units (fillér) -- Stripe's own docs confirm HUF is a normal
    // two-decimal charging currency (only special-cased as zero-decimal
    // for payouts), so a real 5 990 Ft Price reports 599000 here, not
    // 5990. A prior version of this helper used 5990 directly, matching
    // (and thereby masking) the exact same off-by-100 bug this file's own
    // stripe-config.ts once had -- found only by a real Stripe API call
    // during this round's live verification, never by these mocks.
    unit_amount: 599000,
    tax_behavior: "inclusive",
    product: "prod_shared",
    ...overrides,
  };
}

function monthlyOk() {
  return price({ id: MONTHLY_PRICE_ID, recurring: { interval: "month", interval_count: 1 }, unit_amount: 599000 });
}
function yearlyOk() {
  return price({ id: YEARLY_PRICE_ID, recurring: { interval: "year", interval_count: 1 }, unit_amount: 5990000 });
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

  it("does not gate on livemode at all in genuine local development (NODE_ENV=development), regardless of APP_ENV", async () => {
    vi.stubEnv("NODE_ENV", "development");
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

  it("rejects a TEST-mode key when the runtime expects live-mode (production)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/test-mode key, but the runtime expects live-mode/);
  });

  it("rejects a LIVE-mode key when the runtime expects test-mode (preview)", async () => {
    process.env.APP_ENV = "preview";
    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/live-mode key, but the runtime expects test-mode/);
  });

  /**
   * Fourth independent review, Finding 6: the original design only
   * enforced mode agreement for APP_ENV exactly "production"/"preview",
   * silently skipping enforcement for anything else -- including a
   * missing, empty, or misspelled value in a genuinely deployed runtime.
   * resolveExpectedLivemode now fails closed (throws) for every non-
   * development runtime unless APP_ENV is exactly one of those two
   * values.
   */
  describe("Finding 6: fails closed on a missing/malformed APP_ENV in a deployed runtime", () => {
    beforeEach(() => {
      // None of these tests are genuine local development.
      vi.stubEnv("NODE_ENV", "production");
    });

    it("throws when APP_ENV is undefined", async () => {
      delete process.env.APP_ENV;
      const { assertStripeConfigurationValid } = await importFresh();
      await expect(assertStripeConfigurationValid()).rejects.toThrow(/APP_ENV is unset/);
    });

    it("throws when APP_ENV is an empty string", async () => {
      process.env.APP_ENV = "";
      const { assertStripeConfigurationValid } = await importFresh();
      await expect(assertStripeConfigurationValid()).rejects.toThrow(/expected exactly "production" or "preview"/);
    });

    it("throws when APP_ENV is misspelled", async () => {
      process.env.APP_ENV = "produciton";
      const { assertStripeConfigurationValid } = await importFresh();
      await expect(assertStripeConfigurationValid()).rejects.toThrow(/"produciton"/);
    });

    it("accepts APP_ENV exactly 'production'", async () => {
      process.env.APP_ENV = "production";
      const { assertStripeConfigurationValid } = await importFresh();
      await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
    });

    it("accepts APP_ENV exactly 'preview' (with a matching test-mode key/prices)", async () => {
      process.env.APP_ENV = "preview";
      process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
      pricesRetrieve.mockImplementation(async (id: string) =>
        id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), livemode: false }) : price({ ...yearlyOk(), livemode: false }),
      );
      const { assertStripeConfigurationValid } = await importFresh();
      await expect(assertStripeConfigurationValid()).resolves.toBeUndefined();
    });
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
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/is test-mode, but the runtime expects live-mode/);
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
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), recurring: { interval: "year", interval_count: 1 } }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/recurs "year", expected "month"/);
  });

  it("Finding 13: rejects a Price billed every N>1 periods (e.g. quarterly-billed-as-'month') even when the interval unit matches", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), recurring: { interval: "month", interval_count: 3 } }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(/bills every 3 months, expected every 1 month/);
  });

  it("rejects an amount that doesn't match the billing page's promised price", async () => {
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), unit_amount: 498000 }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(
      /charges 498000 \(minor units\) but the billing page promises 5990 Ft \(599000 minor units\)/,
    );
  });

  it("rejects a HUF amount that matches the promised price in whole Forints but not in Stripe's own minor units -- the exact live bug this round found", async () => {
    // A Price genuinely misconfigured to charge 5990 *minor units* (59.90
    // Ft) rather than 5990 Ft (599000 minor units) -- this is the mirror
    // case of the bug this file's own price() helper used to encode by
    // accident: unit_amount and amountHuf coincidentally equal, which is
    // wrong for a real HUF charge, not a passing case.
    pricesRetrieve.mockImplementation(async (id: string) =>
      id === MONTHLY_PRICE_ID ? price({ ...monthlyOk(), unit_amount: 5990 }) : yearlyOk(),
    );
    const { assertStripeConfigurationValid } = await importFresh();
    await expect(assertStripeConfigurationValid()).rejects.toThrow(
      /charges 5990 \(minor units\) but the billing page promises 5990 Ft \(599000 minor units\)/,
    );
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
