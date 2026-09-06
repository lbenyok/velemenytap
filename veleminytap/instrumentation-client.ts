import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData, redactSpan } from "@/lib/sentry-redact";

// See sentry.server.config.ts for why beforeSendTransaction/beforeSendSpan
// (round-6 R6-02) and dataCollection, not sendDefaultPii (round-7 R7-01),
// are needed.
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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
