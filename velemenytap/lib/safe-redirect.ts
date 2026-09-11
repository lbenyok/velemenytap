const FALLBACK = "/dashboard";

/**
 * Validates a user-supplied "next" redirect target (from a query string or
 * form field) and returns a safe, same-origin, path-only string -- or the
 * fallback if the input is anything else.
 *
 * A naive prefix check (`next.startsWith("/") && !next.startsWith("//")`)
 * is NOT sufficient. WHATWG URL parsing -- what a real browser actually
 * uses to resolve a `Location` response header -- treats a backslash the
 * same as a forward slash for "special" schemes like http/https. A string
 * like "/\example.org" passes that prefix check (its second character is
 * "\", not "/") yet a browser parses it identically to "//example.org": a
 * protocol-relative URL pointing at an external host. See
 * safe-redirect.test.ts for a reproduction against Node's own URL parser
 * (the same WHATWG implementation browsers use).
 *
 * Parsing the candidate against a known trusted origin and checking that
 * the *parsed* origin matches is necessary but NOT sufficient on its own
 * (round-2 review finding R2-01, confirmed): a candidate like
 * "/a/..//evil.example/path" resolves same-origin (the ".." pops back to
 * root before the parser ever considers a new authority), yet its
 * resulting pathname is "//evil.example/path" -- which, output as the
 * "safe" redirect target, is ITSELF a protocol-relative URL. Any consumer
 * that later resolves that returned string as a URL (a browser following a
 * `Location` header, or this same logic invoked again downstream) reads
 * the leading "//" as "same scheme, host = evil.example" and leaves the
 * site anyway. The same shape of pathname also arises non-recursively: a
 * same-origin absolute URL like "https://trusted.example//evil.example/path"
 * needs no ".." at all to produce it. Both payloads are covered in
 * safe-redirect.test.ts.
 *
 * The fix: after computing the candidate output, re-parse THAT STRING
 * itself against the trusted origin and require ITS origin to match too --
 * this is not a second pattern-match, it is literally simulating what a
 * real consumer does with the value this function actually hands back
 * (which is the concrete thing that ends up in a `Location` header or a
 * Next.js `redirect()` call, not the original candidate).
 */
export function safeRedirectTarget(
  candidate: unknown,
  trustedOrigin: string = process.env.NEXT_PUBLIC_SITE_URL ?? "",
): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return FALLBACK;
  }

  // Reject control characters (including \n and \r, which could be used to
  // inject extra header lines into contexts that build a raw Location
  // header string) outright, before any parsing.
  if (/[\x00-\x1f\x7f]/.test(candidate)) {
    return FALLBACK;
  }

  let trusted: URL;
  try {
    trusted = new URL(trustedOrigin);
  } catch {
    return FALLBACK;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, trusted);
  } catch {
    return FALLBACK;
  }

  if (parsed.origin !== trusted.origin) {
    return FALLBACK;
  }

  // Path + search + hash only. The origin was already validated above;
  // never let it (or whatever the browser might have normalized the
  // authority to) flow back out as part of the redirect target.
  const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!target.startsWith("/")) {
    return FALLBACK;
  }

  // Re-validate the exact string this function is about to return, not
  // just the original candidate -- see the R2-01 note above.
  let revalidated: URL;
  try {
    revalidated = new URL(target, trusted);
  } catch {
    return FALLBACK;
  }
  if (revalidated.origin !== trusted.origin) {
    return FALLBACK;
  }

  return target;
}
