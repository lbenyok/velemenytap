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

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const MAX_DEPTH = 20;

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
export function redactSensitiveData(event: ErrorEvent): ErrorEvent {
  if (event.request?.data !== undefined) {
    delete event.request.data;
  }
  if (event.extra) {
    event.extra = redactValue(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = redactValue(event.contexts) as typeof event.contexts;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      data: crumb.data ? (redactValue(crumb.data) as typeof crumb.data) : crumb.data,
    }));
  }
  return event;
}
