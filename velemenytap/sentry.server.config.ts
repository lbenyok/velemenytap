import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData, redactSpan } from "@/lib/sentry-redact";

// Round-6 finding R6-02: beforeSend alone never sees transaction events
// (Sentry's tracing pipeline is separate) or individual spans within one --
// a live token in a request URL could reach Sentry through either path
// even with beforeSend fully redacting plain error events. beforeSendSpan
// is the hook that can actually reach span-level data in this SDK version;
// see lib/sentry-redact.ts's redactSpan for what it covers.
//
// Round-7 finding R7-01: `sendDefaultPii: false` (round 6's choice) is
// itself `@deprecated` in this exact installed SDK version
// (@sentry/core@10.73.0's own type definition says so) in favor of the
// `dataCollection` option -- confirmed by reading resolveDataCollectionOptions.js
// directly: passing `dataCollection` at all switches the SDK's *base*
// defaults away from whatever `sendDefaultPii` would have implied, back to
// its own fully-permissive defaults (collect all cookies/headers/bodies).
// Setting only `dataCollection.urlQueryParams: false` without also
// re-stating the other fields would therefore have been a silent
// *regression* from round 6's posture, not just an incomplete fix -- every
// field below is explicit for that reason, not merely urlQueryParams.
// `urlQueryParams: false` disables Sentry's own query-string collection at
// the source (per its own type: "false: Do not collect any data"), which
// is what actually closes the `http.target`/`url.full` query-string leak
// this finding reproduced -- lib/sentry-redact.ts's explicit redaction
// remains as defense-in-depth underneath this, not a replacement for it.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  dataCollection: {
    urlQueryParams: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    databaseQueryData: false,
  },
  beforeSend: redactSensitiveData,
  beforeSendTransaction: redactSensitiveData,
  beforeSendSpan: redactSpan,
});
