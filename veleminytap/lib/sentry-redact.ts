import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Field names that may carry customer-submitted free text (feedback content,
 * internal notes) and must never leave this app in an error report -- see
 * SECURITY.md § Error handling / logging. Applied to request bodies, extra
 * context, and breadcrumb data on every event before it's sent.
 */
const SENSITIVE_KEYS = new Set(["feedback_text", "feedbackText", "internal_note", "internalNote"]);

function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : redactDeep(val, seen);
    }
    return result;
  }
  return value;
}

/** Shared beforeSend hook for the client/server/edge Sentry configs. */
export function redactSensitiveData(event: ErrorEvent): ErrorEvent {
  if (event.request?.data) {
    event.request.data = redactDeep(event.request.data);
  }
  if (event.extra) {
    event.extra = redactDeep(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = redactDeep(event.contexts) as typeof event.contexts;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      data: crumb.data ? (redactDeep(crumb.data) as typeof crumb.data) : crumb.data,
    }));
  }
  return event;
}
