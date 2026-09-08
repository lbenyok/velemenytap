import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs/config"

const nextConfig: NextConfig = {}

// No org/project/authToken configured yet -- source map upload is skipped
// (silent, no build warnings) until SENTRY_AUTH_TOKEN is wired up. Error
// capture itself works fully without it; see DECISIONS.md.
export default withSentryConfig(nextConfig, {
  silent: true,
})
