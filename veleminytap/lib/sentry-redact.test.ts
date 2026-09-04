import { describe, it, expect } from "vitest";
import { redactSensitiveData } from "./sentry-redact";
import type { ErrorEvent } from "@sentry/nextjs";

function event(overrides: Partial<ErrorEvent>): ErrorEvent {
  return overrides as ErrorEvent;
}

/**
 * A distinctive string that would never appear in this codebase or in
 * Sentry's own SDK internals by coincidence -- used so tests assert against
 * the actual serialized output ("does this canary appear ANYWHERE in the
 * final event, under any key, at any depth") rather than against a specific
 * key the implementation happens to check today. This is what catches
 * regressions the original key-only tests couldn't: a canary hidden inside
 * a JSON-stringified value, behind a repeated reference, or reachable only
 * through a cycle.
 */
const CANARY = "CANARY_SECRET_9f3a1c";

function serialized(result: ErrorEvent): string {
  // Sentry events are eventually JSON-serialized for transport; asserting
  // against that representation (not just `.toEqual` on specific fields)
  // is what "do not claim complete protection based only on testing plain
  // object keys" (per the review) actually requires.
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? String(value) : value));
}

describe("redactSensitiveData", () => {
  describe("request body: dropped entirely, not redacted in place", () => {
    it("removes request.data even when it holds the canary under a sensitive key", () => {
      const result = redactSensitiveData(
        event({ request: { data: { public_id: "abc", rating: 1, feedback_text: CANARY } } }),
      );
      expect(result.request?.data).toBeUndefined();
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("removes request.data even when the canary is under an unrelated key", () => {
      // request.data is typed `unknown` by Sentry -- it can be any shape,
      // including one that doesn't use any of our known sensitive key
      // names at all. The fix must not depend on recognizing the key.
      const result = redactSensitiveData(
        event({ request: { data: { some_other_field: CANARY, notes: "fine" } } }),
      );
      expect(result.request?.data).toBeUndefined();
    });

    it("removes request.data when it's a raw string, not an object", () => {
      const result = redactSensitiveData(event({ request: { data: `raw body: ${CANARY}` } }));
      expect(result.request?.data).toBeUndefined();
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("removes request.data when it's an array", () => {
      const result = redactSensitiveData(event({ request: { data: [CANARY, "other"] } }));
      expect(result.request?.data).toBeUndefined();
    });

    it("leaves the rest of event.request (url, method) untouched", () => {
      const result = redactSensitiveData(
        event({ request: { url: "https://example.com/r/abc", method: "POST", data: { feedback_text: CANARY } } }),
      );
      expect(result.request?.url).toBe("https://example.com/r/abc");
      expect(result.request?.method).toBe("POST");
      expect(result.request?.data).toBeUndefined();
    });
  });

  describe("extra/contexts/breadcrumbs: key-based redaction", () => {
    it("redacts feedback_text nested inside extra", () => {
      const result = redactSensitiveData(event({ extra: { feedback: { id: 1, feedback_text: CANARY } } }));
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("redacts internal_note nested inside extra", () => {
      const result = redactSensitiveData(
        event({ extra: { feedback: { id: 1, internal_note: "call the customer back" } } }),
      );
      expect(result.extra).toEqual({ feedback: { id: 1, internal_note: "[redacted]" } });
    });

    it("redacts sensitive fields inside breadcrumb data", () => {
      const result = redactSensitiveData(
        event({ breadcrumbs: [{ message: "submit", data: { feedbackText: CANARY } }] }),
      );
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("redacts sensitive fields inside contexts", () => {
      const result = redactSensitiveData(
        event({ contexts: { feedback: { internal_note: CANARY } } }) as unknown as ErrorEvent,
      );
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("leaves non-sensitive fields untouched", () => {
      const result = redactSensitiveData(event({ extra: { rating: 5, location: "Main Street" } }));
      expect(result.extra).toEqual({ rating: 5, location: "Main Street" });
    });
  });

  describe("serialized JSON strings carrying a sensitive field", () => {
    it("redacts a canary hidden inside a JSON-stringified value in extra", () => {
      const result = redactSensitiveData(
        event({ extra: { payload: JSON.stringify({ public_id: "abc", feedback_text: CANARY }) } }),
      );
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("redacts a canary inside a JSON-stringified array in a breadcrumb", () => {
      const result = redactSensitiveData(
        event({ breadcrumbs: [{ message: "batch", data: { items: JSON.stringify([{ internal_note: CANARY }]) } }] }),
      );
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("leaves an ordinary non-JSON string untouched", () => {
      const result = redactSensitiveData(event({ extra: { note: "just a plain string, not JSON" } }));
      expect(result.extra).toEqual({ note: "just a plain string, not JSON" });
    });

    it("leaves a string that merely starts with '{' but isn't valid JSON untouched", () => {
      const result = redactSensitiveData(event({ extra: { note: "{not valid json" } }));
      expect(result.extra).toEqual({ note: "{not valid json" });
    });
  });

  describe("repeated references (not circular, but the same object twice)", () => {
    it("never returns the original unredacted object on a second occurrence", () => {
      const shared = { feedback_text: CANARY };
      const result = redactSensitiveData(event({ extra: { first: shared, second: shared } }));
      const extra = result.extra as { first: { feedback_text: string }; second: { feedback_text: string } };
      expect(extra.first.feedback_text).toBe("[redacted]");
      expect(extra.second.feedback_text).toBe("[redacted]");
      // Neither branch may be a reference to the original, canary-carrying object.
      expect(extra.first).not.toBe(shared);
      expect(extra.second).not.toBe(shared);
      expect(serialized(result)).not.toContain(CANARY);
    });
  });

  describe("circular references", () => {
    it("does not throw, does not leak the canary, and does not return the original object through the back-reference", () => {
      const circular: Record<string, unknown> = { feedback_text: CANARY };
      circular.self = circular;

      let result!: ErrorEvent;
      expect(() => {
        result = redactSensitiveData(event({ extra: { circular } }));
      }).not.toThrow();

      const redactedCircular = (result.extra as { circular: Record<string, unknown> }).circular;
      expect(redactedCircular.feedback_text).toBe("[redacted]");
      // This is the fix for the bug the previous test suite asserted as
      // correct behavior: the back-reference must NOT be the original,
      // still-unredacted `circular` object.
      expect(redactedCircular.self).not.toBe(circular);
      expect(redactedCircular.self).toBe("[circular]");
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("handles a longer cycle (A -> B -> A) without leaking either side", () => {
      const a: Record<string, unknown> = { feedback_text: CANARY };
      const b: Record<string, unknown> = { internal_note: "also secret", back: a };
      a.next = b;

      const result = redactSensitiveData(event({ extra: { a } }));
      expect(serialized(result)).not.toContain(CANARY);
      expect(serialized(result)).not.toContain("also secret");
    });

    it("handles a self-referencing array without a RangeError", () => {
      // A bare string with no enclosing key isn't something key-based
      // redaction can act on (there's nothing to match against
      // SENSITIVE_KEYS) -- what's under test here is specifically the
      // "self-referencing array causes a RangeError" claim, i.e. that this
      // completes at all rather than blowing the call stack.
      const arr: unknown[] = ["unrelated value"];
      arr.push(arr);

      let result!: ErrorEvent;
      expect(() => {
        result = redactSensitiveData(event({ extra: { arr } }));
      }).not.toThrow();
      const extra = result.extra as { arr: unknown[] };
      expect(extra.arr[0]).toBe("unrelated value");
      expect(extra.arr[1]).toBe("[circular]");
    });

    it("handles a circular reference reached only through an array", () => {
      const node: Record<string, unknown> = { internal_note: CANARY };
      const arr: unknown[] = [node];
      node.siblings = arr;

      let result!: ErrorEvent;
      expect(() => {
        result = redactSensitiveData(event({ extra: { arr } }));
      }).not.toThrow();
      expect(serialized(result)).not.toContain(CANARY);
    });
  });

  describe("robustness", () => {
    it("does not throw on events with no request/extra/contexts/breadcrumbs", () => {
      expect(() => redactSensitiveData(event({}))).not.toThrow();
    });

    it("does not stack-overflow on a pathologically deep (non-circular) structure", () => {
      let deep: Record<string, unknown> = { feedback_text: CANARY };
      for (let i = 0; i < 500; i++) {
        deep = { child: deep };
      }
      let result!: ErrorEvent;
      expect(() => {
        result = redactSensitiveData(event({ extra: { deep } }));
      }).not.toThrow();
      expect(serialized(result)).not.toContain(CANARY);
    });

    it("redacts sibling branches independently after a shared object is consumed (no cross-branch leakage from the path-scoped seen set)", () => {
      const shared = { internal_note: CANARY };
      const tree = { branchA: { child: shared }, branchB: { child: shared } };
      const result = redactSensitiveData(event({ extra: tree }));
      expect(serialized(result)).not.toContain(CANARY);
    });
  });
});
