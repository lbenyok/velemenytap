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
 * The only reliable check is to actually parse the candidate as a URL
 * against a known trusted origin and require the *parsed* origin to match
 * exactly -- not to pattern-match the raw string.
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

  // Return path + search + hash only. The origin was already validated
  // above; never let it (or whatever the browser might have normalized
  // the authority to) flow back out as part of the redirect target.
  const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return target.startsWith("/") ? target : FALLBACK;
}
