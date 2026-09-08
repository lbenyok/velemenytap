import { describe, it, expect } from "vitest";
import { feedbackSchema } from "./schema";

const validPublicId = "346f9cff-2441-4adc-9f7f-b7a2de1db634";

describe("feedbackSchema", () => {
  // Review-gating regression test (see PRODUCT_SPEC.md / TEST_PLAN.md): the
  // submission schema itself must accept all five ratings identically, with
  // no rating-dependent branching that could become a foothold for gating
  // the Google Review CTA later.
  it.each([1, 2, 3, 4, 5])("accepts rating %i", (rating) => {
    const result = feedbackSchema.safeParse({
      public_id: validPublicId,
      rating,
      feedback_text: "",
    });
    expect(result.success).toBe(true);
  });

  it.each([0, 6, -1, 3.5])("rejects out-of-range or non-integer rating %s", (rating) => {
    const result = feedbackSchema.safeParse({
      public_id: validPublicId,
      rating,
      feedback_text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID public_id", () => {
    const result = feedbackSchema.safeParse({
      public_id: "not-a-uuid",
      rating: 5,
      feedback_text: "",
    });
    expect(result.success).toBe(false);
  });

  it("normalizes empty feedback text to null rather than an empty string", () => {
    const result = feedbackSchema.safeParse({
      public_id: validPublicId,
      rating: 5,
      feedback_text: "   ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feedback_text).toBeNull();
    }
  });

  it("rejects feedback text over 1000 characters", () => {
    const result = feedbackSchema.safeParse({
      public_id: validPublicId,
      rating: 3,
      feedback_text: "a".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("coerces a string rating from form data", () => {
    const result = feedbackSchema.safeParse({
      public_id: validPublicId,
      rating: "4",
      feedback_text: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rating).toBe(4);
    }
  });
});
