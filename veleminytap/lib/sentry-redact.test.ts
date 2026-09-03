import { describe, it, expect } from "vitest";
import { redactSensitiveData } from "./sentry-redact";
import type { ErrorEvent } from "@sentry/nextjs";

function event(overrides: Partial<ErrorEvent>): ErrorEvent {
  return overrides as ErrorEvent;
}

describe("redactSensitiveData", () => {
  it("redacts feedback_text in request body data", () => {
    const result = redactSensitiveData(
      event({
        request: { data: { public_id: "abc", rating: 1, feedback_text: "the coffee was cold" } },
      }),
    );
    expect(result.request?.data).toEqual({
      public_id: "abc",
      rating: 1,
      feedback_text: "[redacted]",
    });
  });

  it("redacts internal_note nested inside extra context", () => {
    const result = redactSensitiveData(
      event({
        extra: { feedback: { id: 1, internal_note: "call the customer back" } },
      }),
    );
    expect(result.extra).toEqual({ feedback: { id: 1, internal_note: "[redacted]" } });
  });

  it("redacts sensitive fields inside breadcrumb data", () => {
    const result = redactSensitiveData(
      event({
        breadcrumbs: [{ message: "submit", data: { feedbackText: "terrible service" } }],
      }),
    );
    expect(result.breadcrumbs?.[0].data).toEqual({ feedbackText: "[redacted]" });
  });

  it("leaves non-sensitive fields untouched", () => {
    const result = redactSensitiveData(
      event({ extra: { rating: 5, location: "Main Street" } }),
    );
    expect(result.extra).toEqual({ rating: 5, location: "Main Street" });
  });

  it("does not throw on events with no request/extra/contexts/breadcrumbs", () => {
    expect(() => redactSensitiveData(event({}))).not.toThrow();
  });

  it("handles circular references without infinite recursion", () => {
    const circular: Record<string, unknown> = { feedback_text: "hi" };
    circular.self = circular;
    const result = redactSensitiveData(event({ extra: { circular } }));
    const redactedCircular = (result.extra as { circular: Record<string, unknown> }).circular;
    expect(redactedCircular.feedback_text).toBe("[redacted]");
    expect(redactedCircular.self).toBe(circular);
  });
});
