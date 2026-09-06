import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData, redactSpan } from "@/lib/sentry-redact";

// See sentry.server.config.ts for why beforeSendTransaction/beforeSendSpan
// are needed alongside beforeSend (round-6 R6-02).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: false,
  beforeSend: redactSensitiveData,
  beforeSendTransaction: redactSensitiveData,
  beforeSendSpan: redactSpan,
});
