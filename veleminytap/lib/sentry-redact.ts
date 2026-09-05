import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Field names that may carry customer-submitted free text (feedback content,
 * internal notes) -- see SECURITY.md § Error handling / logging.
 *
 * This is defense-in-depth, not the primary control. Key-name matching can
 * only catch sensitive data stored under one of these exact keys; it can't
 * catch free text serialized into a string (e.g. a JSON blob, or a Postgres
 * error message that echoes a failed row's values) or shipped under some
 * other key entirely. The primary control is minimizing telemetry: request
 * bodies are dropped outright below rather than redacted in place, since
 * this app has no legitimate debugging need to see submitted form data, and
 * an unpredictable `unknown`-typed body (Sentry's own type for
 * `request.data`) can't be safely walked by field name at all.
 */
const SENSITIVE_KEYS = new Set(["feedback_text", "feedbackText", "internal_note", "internalNote"]);

/**
 * Round-5 finding R5-11. This app hands out real, live, single-use
 * credentials as URL query parameters by design -- `/api/notification-
 * email/confirm?token=...` (round-3 R3-03) and `/auth/confirm?token_hash=
 * ...` (Supabase's own email-OTP link) both work exactly this way, since
 * the whole point is a link someone clicks from an email with no session
 * to carry the credential in instead. Nothing above ever touched
 * `event.request.url` or breadcrumb navigation URLs, so an exception
 * thrown before either route consumes its token -- still valid at that
 * point -- would ship the live credential to Sentry. `code` is included
 * pre-emptively for the same shape of risk (a common OAuth/magic-link
 * param name this app doesn't currently use, but the exact kind of
 * parameter that would need this the moment it did).
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "token_hash",
  "code",
  "secret",
  "password",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
]);
const REDACTED_QUERY_VALUE = "[redacted]";

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const MAX_DEPTH = 20;

/**
 * Redacts the value of any sensitive-looking query parameter in a URL,
 * leaving everything else (path, other params) intact for debugging.
 * Works on both absolute and relative URLs -- Sentry's own event/
 * breadcrumb URLs are frequently relative (`/auth/confirm?...`), which
 * the global `URL` constructor rejects without a base.
 */
export function sanitizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://placeholder.invalid");
  } catch {
    // Not a URL at all (or too malformed to parse) -- nothing to sanitize,
    // but also nothing structured to leak via a query string either.
    return rawUrl;
  }

  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED_QUERY_VALUE);
      changed = true;
    }
  }
  if (!changed) {
    return rawUrl;
  }
  // Reconstruct relative to how it was given -- don't turn a relative URL
  // into an absolute one just because sanitization needed a placeholder
  // base to parse it.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) || rawUrl.startsWith("//");
  return isAbsolute ? url.toString() : url.pathname + url.search + url.hash;
}

/**
 * Recursively redacts sensitive keys from an arbitrary value, safe for
 * cycles, repeated (non-circular) references, and arrays.
 *
 * `seen` is a path-scoped set (added on entry, removed in `finally`), not a
 * whole-tree set: two sibling branches that happen to reference the same
 * object are each redacted independently and correctly, and only a true
 * ancestor->descendant cycle is replaced with "[circular]". Critically,
 * nothing in this function ever returns the original `value` for an
 * object/array once it's been visited -- the earlier implementation did
 * (`return value` on a repeat/cycle), which leaked a fully unredacted
 * object graph through any back-reference or shared reference.
 */
function redactDeep(value: unknown, seen: Set<object>, depth = 0): unknown {
  if (typeof value === "string") {
    return redactJsonStringIfSensitive(value, seen, depth);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_DEPTH) {
    // Not a cycle, just pathologically deep -- fail safe rather than risk a
    // stack overflow on a shape we didn't anticipate.
    return "[max-depth-exceeded]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => redactDeep(v, seen, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redactDeep(val, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * A string value might itself be a JSON-serialized object/array carrying a
 * sensitive field (e.g. an `extra` value that's `JSON.stringify`'d payload
 * data) -- key-name matching on the *parent* object can't see inside it.
 * Cheaply guards on a leading `{`/`[` before attempting a parse, and only
 * re-stringifies if the parse actually succeeds and needed redaction.
 */
function redactJsonStringIfSensitive(value: string, seen: Set<object>, depth: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !(trimmed[0] === "{" || trimmed[0] === "[")) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value;
  }
  if (parsed === null || typeof parsed !== "object") {
    return value;
  }
  return JSON.stringify(redactDeep(parsed, seen, depth + 1));
}

function redactValue(value: unknown): unknown {
  return redactDeep(value, new Set<object>());
}

/**
 * Shared beforeSend hook for the client/server/edge Sentry configs.
 *
 * Request bodies (`event.request.data`) are dropped entirely, not redacted
 * in place: Sentry types this field as `unknown` (it can be a string, an
 * object, a parsed FormData-shaped structure, or something else entirely
 * depending on the SDK's request instrumentation), so there is no shape we
 * can safely walk by field name with confidence. This app has no debugging
 * need to see submitted request bodies, so the simplest safe answer is to
 * never send them. `extra`/`contexts`/`breadcrumbs` are still deep-redacted
 * (defense-in-depth for whatever future code or SDK auto-instrumentation
 * might put there), never by returning an unredacted original reference.
 */
/**
 * Breadcrumb URL fields Sentry's own instrumentation (navigation, fetch,
 * XHR) populates -- checked and sanitized in place, in addition to (not
 * instead of) the general redactDeep pass below, since redactDeep only
 * knows how to redact a whole value under a known key, not sanitize a
 * query string within one it doesn't otherwise touch.
 */
const BREADCRUMB_URL_KEYS = ["url", "to", "from"];

export function redactSensitiveData(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    if (event.request.data !== undefined) {
      delete event.request.data;
    }
    if (event.request.url) {
      event.request.url = sanitizeUrl(event.request.url);
    }
    // Round-5 R5-11: defensive even though this app's own Sentry config
    // doesn't deliberately enable cookie/header capture -- a session
    // cookie or an Authorization header is exactly the shape of thing
    // this file exists to keep out of telemetry, and costs nothing to
    // strip outright rather than trust that no future SDK default or
    // config change ever turns it on.
    delete event.request.cookies;
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (/^(cookie|authorization)$/i.test(key)) {
          delete event.request.headers[key];
        }
      }
    }
  }
  if (event.extra) {
    event.extra = redactValue(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = redactValue(event.contexts) as typeof event.contexts;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      const data = crumb.data ? (redactValue(crumb.data) as Record<string, unknown>) : crumb.data;
      if (data) {
        for (const key of BREADCRUMB_URL_KEYS) {
          if (typeof data[key] === "string") {
            data[key] = sanitizeUrl(data[key]);
          }
        }
      }
      return { ...crumb, data };
    });
  }
  return event;
}
