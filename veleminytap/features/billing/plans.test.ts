import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isBillingInterval, stripePriceId } from "./plans";

describe("isBillingInterval", () => {
  it("accepts the two real intervals", () => {
    expect(isBillingInterval("monthly")).toBe(true);
    expect(isBillingInterval("yearly")).toBe(true);
  });

  it.each([null, undefined, "", "yearly ", "MONTHLY", "weekly", 42, {}])(
    "rejects %j -- a crafted form submission must not reach stripePriceId with an unvalidated value",
    (value) => {
      expect(isBillingInterval(value)).toBe(false);
    },
  );
});

describe("stripePriceId", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_PRICE_ID_MONTHLY = "price_monthly_test";
    process.env.STRIPE_PRICE_ID_YEARLY = "price_yearly_test";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("resolves each interval to its own env-configured Price id", () => {
    expect(stripePriceId("monthly")).toBe("price_monthly_test");
    expect(stripePriceId("yearly")).toBe("price_yearly_test");
  });
});
