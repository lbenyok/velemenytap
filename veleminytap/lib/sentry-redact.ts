import type { ErrorEvent } from "@sentry/nextjs";
import type { TransactionEvent, SpanJSON } from "@sentry/core";

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
 * Round-6 finding R6-02: the general URL sanitizer above only ever touched
 * `event.request.url` -- Sentry's `Request` shape has a SEPARATE
 * `query_string` field (populated by some SDK instrumentation instead of,
 * or alongside, `url`), which none of round 5's fix touched at all. A
 * canary placed there survived redaction outright. `query_string` can be a
 * plain string ("a=1&b=2"), an object ({a: "1", b: "2"}), or an array of
 * [key, value] pairs -- Sentry's own type allows all three -- so this
 * handles each shape explicitly rather than assuming one.
 */
type QueryParams = string | Record<string, string> | Array<[string, string]>;

function sanitizeQueryParams(qs: QueryParams): QueryParams {
  if (typeof qs === "string") {
    if (!qs) return qs;
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        params.set(key, REDACTED_QUERY_VALUE);
        changed = true;
      }
    }
    return changed ? params.toString() : qs;
  }
  if (Array.isArray(qs)) {
    return qs.map(([key, value]): [string, string] =>
      SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ? [key, REDACTED_QUERY_VALUE] : [key, value],
    );
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(qs)) {
    result[key] = SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ? REDACTED_QUERY_VALUE : value;
  }
  return result;
}

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

export function redactSensitiveData<T extends ErrorEvent | TransactionEvent>(event: T): T {
  if (event.request) {
    if (event.request.data !== undefined) {
      delete event.request.data;
    }
    if (event.request.url) {
      event.request.url = sanitizeUrl(event.request.url);
    }
    // Round-6 R6-02: a separate field from request.url, not covered above.
    if (event.request.query_string) {
      event.request.query_string = sanitizeQueryParams(event.request.query_string as QueryParams);
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
  // Defensive: Next.js/OpenTelemetry name HTTP transactions from a route
  // TEMPLATE ("GET /api/notification-email/confirm"), never the literal
  // URL with its query string, so this should already be a no-op in
  // practice -- kept because the finding explicitly calls out "transaction
  // names" and a no-op guard here costs nothing.
  if (typeof event.transaction === "string") {
    event.transaction = sanitizeUrl(event.transaction);
  }
  // Found during this round's own independent adversarial self-review:
  // nothing above ever touched event.exception -- the actual error message
  // text Sentry captures for every crash. No current code path in this app
  // embeds a token/URL in a thrown Error's message (checked directly), so
  // this isn't a live leak today, but it's exactly the kind of structural
  // gap this file exists to close defensively -- a future `throw new
  // Error(\`failed for ${url}\`)` anywhere in the app would otherwise ship
  // a live confirmation token to Sentry with no redaction pass in its way
  // at all. Same treatment as event.transaction/span.description above:
  // sanitizeUrl catches a token embedded in a URL-shaped message, and the
  // JSON-string check catches one embedded in a serialized object.
  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === "string") {
        value.value = redactJsonStringIfSensitive(sanitizeUrl(value.value), new Set<object>(), 0);
      }
    }
  }
  return event;
}

/**
 * Round-6 finding R6-02: `beforeSend`/`beforeSendTransaction` never see
 * individual spans within a transaction -- Sentry's HTTP instrumentation
 * attaches the full request URL (query string included) to span data under
 * various semantic-convention attribute names, so a live token could reach
 * Sentry through a transaction's child spans even with
 * `beforeSend`/`beforeSendTransaction` fully redacting the transaction
 * event itself. Wired up as `beforeSendSpan` in every Sentry config
 * (client/server/edge) alongside the other two hooks -- this is the one
 * hook that can actually reach span-level data in this SDK version.
 *
 * Round-7 finding R7-01 (HIGH): this originally covered only `url.full` and
 * `http.url`. `http.target` (the OpenTelemetry HTTP semantic-convention
 * attribute for a server span's raw `pathname + search`, confirmed present
 * as a real constant in the installed @sentry/vercel-edge 10.73.0 bundle,
 * which sentry.edge.config.ts uses for this app's own Edge-runtime
 * middleware) was not covered, and reproduced leaking a canary unchanged.
 * `url.original` (another semantic-convention alias for the same shape) is
 * covered for the same defensive reason `http.url` already was -- "the
 * older/alternate name, still emitted by some integrations." Full
 * path-plus-query values use `sanitizeUrl` (it already handles a bare
 * `pathname?query` string, the exact shape `http.target`/`url.original`
 * carry); bare-query-string attributes use `sanitizeQueryParams`.
 */
const SPAN_URL_ATTRIBUTE_KEYS = ["url.full", "http.url", "http.target", "url.original"];
const SPAN_QUERY_ATTRIBUTE_KEYS = ["url.query", "http.query"];

export function redactSpan(span: SpanJSON): SpanJSON {
  const data = span.data ? { ...span.data } : span.data;
  if (data) {
    for (const key of SPAN_URL_ATTRIBUTE_KEYS) {
      const value = data[key];
      if (typeof value === "string") {
        data[key] = sanitizeUrl(value);
      }
    }
    for (const key of SPAN_QUERY_ATTRIBUTE_KEYS) {
      const value = data[key];
      // Sentry's own `url.query` is stored WITH its leading "?"
      // (URL.prototype.search's own format) -- sanitizeQueryParams's
      // string branch already handles that prefix itself.
      if (typeof value === "string") {
        data[key] = sanitizeQueryParams(value) as string;
      }
    }
  }
  // Defensive, same reasoning as event.transaction in redactSensitiveData:
  // Sentry's own span-naming strips query strings from `description`
  // already, but a future SDK change or manually-instrumented span isn't
  // guaranteed to.
  const description = typeof span.description === "string" ? sanitizeUrl(span.description) : span.description;
  return { ...span, ...(data ? { data } : {}), description };
}
