import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData, redactSpan } from "@/lib/sentry-redact";

// Round-6 finding R6-02: beforeSend alone never sees transaction events
// (Sentry's tracing pipeline is separate) or individual spans within one --
// a live token in a request URL could reach Sentry through either path
// even with beforeSend fully redacting plain error events. beforeSendSpan
// is the hook that can actually reach span-level data in this SDK version;
// see lib/sentry-redact.ts's redactSpan for what it covers.
// sendDefaultPii is left explicitly false (the SDK default) rather than
// implicit-by-omission -- per the finding's "prefer disabling query-string
// collection when possible in addition to redaction": true would ask
// Sentry's own instrumentation to collect more (cookies, full headers, URL
// query params) than this app ever wants sent, as a second layer beneath
// the explicit redaction above, not a replacement for it.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: false,
  beforeSend: redactSensitiveData,
  beforeSendTransaction: redactSensitiveData,
  beforeSendSpan: redactSpan,
});
