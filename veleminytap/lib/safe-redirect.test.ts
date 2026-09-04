import { describe, it, expect } from "vitest";
import { safeRedirectTarget } from "./safe-redirect";

const TRUSTED = "https://veleminytap.vercel.app";

describe("safeRedirectTarget", () => {
  describe("valid internal paths and query strings", () => {
    it("passes through a simple internal path", () => {
      expect(safeRedirectTarget("/dashboard/feedback", TRUSTED)).toBe("/dashboard/feedback");
    });

    it("preserves query strings", () => {
      expect(safeRedirectTarget("/dashboard/feedback?status=new&rating=5", TRUSTED)).toBe(
        "/dashboard/feedback?status=new&rating=5",
      );
    });

    it("preserves a hash fragment", () => {
      expect(safeRedirectTarget("/dashboard#section", TRUSTED)).toBe("/dashboard#section");
    });

    it("passes through the root path", () => {
      expect(safeRedirectTarget("/", TRUSTED)).toBe("/");
    });
  });

  describe("absolute external URLs", () => {
    it("rejects a different https host", () => {
      expect(safeRedirectTarget("https://evil.example.com/phish", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a different http host", () => {
      expect(safeRedirectTarget("http://evil.example.com", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a subdomain that isn't the trusted origin", () => {
      expect(safeRedirectTarget("https://evil.veleminytap.vercel.app", TRUSTED)).toBe("/dashboard");
    });

    it("rejects the trusted host on the wrong port", () => {
      expect(safeRedirectTarget("https://veleminytap.vercel.app:8443/dashboard", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a non-http(s) scheme (javascript:)", () => {
      expect(safeRedirectTarget("javascript:alert(1)", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a data: URL", () => {
      expect(safeRedirectTarget("data:text/html,<script>alert(1)</script>", TRUSTED)).toBe("/dashboard");
    });
  });

  describe("protocol-relative URLs", () => {
    it("rejects //evil.example.com", () => {
      expect(safeRedirectTarget("//evil.example.com", TRUSTED)).toBe("/dashboard");
    });

    it("rejects ///evil.example.com (extra slash)", () => {
      expect(safeRedirectTarget("///evil.example.com", TRUSTED)).toBe("/dashboard");
    });
  });

  describe("backslash variants (the confirmed bypass)", () => {
    // Reproduces the exact claim: WHATWG URL parsing treats a backslash
    // the same as a forward slash for http/https, so "/\evil.example.com"
    // is browser-equivalent to "//evil.example.com" even though it starts
    // with a single "/" and would pass a naive `startsWith("/") &&
    // !startsWith("//")` check.
    it("independently reproduces the bypass against the WHATWG URL parser", () => {
      const malicious = "/" + "\\" + "evil.example.com";
      // Sanity check on the underlying platform parser this fix relies on.
      const resolved = new URL(malicious, TRUSTED);
      expect(resolved.origin).not.toBe(TRUSTED);
      // The naive check the original code used would have let this through.
      expect(malicious.startsWith("/") && !malicious.startsWith("//")).toBe(true);
    });

    it("rejects /\\evil.example.com", () => {
      const malicious = "/" + "\\" + "evil.example.com";
      expect(safeRedirectTarget(malicious, TRUSTED)).toBe("/dashboard");
    });

    it("rejects \\/evil.example.com", () => {
      const malicious = "\\" + "/evil.example.com";
      expect(safeRedirectTarget(malicious, TRUSTED)).toBe("/dashboard");
    });

    it("rejects \\\\evil.example.com", () => {
      const malicious = "\\" + "\\" + "evil.example.com";
      expect(safeRedirectTarget(malicious, TRUSTED)).toBe("/dashboard");
    });
  });

  describe("control characters", () => {
    it("rejects a newline-injected value", () => {
      expect(safeRedirectTarget("/dashboard\nSet-Cookie: evil=1", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a carriage-return-injected value", () => {
      expect(safeRedirectTarget("/dashboard\r\nLocation: https://evil.example.com", TRUSTED)).toBe("/dashboard");
    });

    it("rejects a null byte", () => {
      expect(safeRedirectTarget("/dashboard\x00", TRUSTED)).toBe("/dashboard");
    });
  });

  describe("encoded variants", () => {
    it("treats a percent-encoded scheme as an inert path segment, not a decoded external URL", () => {
      // "https%3A%2F%2Fevil.example.com" doesn't start with a literal
      // "https:" (the "://" is percent-encoded), so WHATWG URL parsing
      // never recognizes it as a scheme change -- it's resolved as a
      // same-origin relative path. This is safe (stays on-origin) even
      // though it wasn't the specific rejection this test first assumed;
      // asserting the actual, safe outcome rather than a wrong guess.
      const result = safeRedirectTarget("https%3A%2F%2Fevil.example.com", TRUSTED);
      const resolved = new URL(result, TRUSTED);
      expect(resolved.origin).toBe(TRUSTED);
    });

    it("leaves a percent-encoded internal path safely on-origin", () => {
      const result = safeRedirectTarget("/dashboard/%5Cevil.example.com", TRUSTED);
      // Whatever this normalizes to, it must stay on the trusted origin.
      expect(result.startsWith("/")).toBe(true);
      const resolved = new URL(result, TRUSTED);
      expect(resolved.origin).toBe(TRUSTED);
    });

    it("rejects an encoded backslash used to smuggle a protocol-relative URL", () => {
      // Some environments decode %5C to "\" before routing; if that ever
      // happens upstream of this function the raw candidate passed in
      // would already contain a literal backslash, which the backslash
      // tests above cover. This checks the function's own behavior on the
      // still-encoded form: it must not decode-then-redirect externally.
      const result = safeRedirectTarget("/%5Cevil.example.com", TRUSTED);
      const resolved = new URL(result, TRUSTED);
      expect(resolved.origin).toBe(TRUSTED);
    });
  });

  describe("missing and malformed input", () => {
    it("falls back on undefined", () => {
      expect(safeRedirectTarget(undefined, TRUSTED)).toBe("/dashboard");
    });

    it("falls back on null", () => {
      expect(safeRedirectTarget(null, TRUSTED)).toBe("/dashboard");
    });

    it("falls back on an empty string", () => {
      expect(safeRedirectTarget("", TRUSTED)).toBe("/dashboard");
    });

    it("falls back on a non-string (number)", () => {
      expect(safeRedirectTarget(42, TRUSTED)).toBe("/dashboard");
    });

    it("falls back on a FormDataEntryValue-shaped File-like object", () => {
      expect(safeRedirectTarget({ name: "file.txt" }, TRUSTED)).toBe("/dashboard");
    });

    it("falls back on an unparseable string", () => {
      expect(safeRedirectTarget("http://[::::]", TRUSTED)).toBe("/dashboard");
    });

    it("falls back when the trusted origin itself is malformed", () => {
      expect(safeRedirectTarget("/dashboard", "not-a-url")).toBe("/dashboard");
    });
  });
});
