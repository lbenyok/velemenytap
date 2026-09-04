import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

// Deliberately forced empty for every test run, regardless of what a local
// .env.test.local file says (round-2 finding R2-06: "explicitly disable
// external email and telemetry side effects in tests" -- not just via the
// incidental omission of these two keys from that file, which a future
// copy-paste from .env.local could silently undo). No test in this suite
// should ever cause a real email send or a real Sentry event; forcing
// these empty makes that true regardless of what any config file contains.
const FORCE_DISABLED_KEYS = ["RESEND_API_KEY", "NEXT_PUBLIC_SENTRY_DSN"] as const;

function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) vars[key] = value;
  }
  return vars;
}

/**
 * Playwright test files run directly under Node, not through Next.js's own
 * env loading -- so an .env file isn't picked up automatically here. Load
 * it by hand, same parsing this project already uses in its one-off admin
 * scripts.
 *
 * Fails closed (round-2 finding R2-06), not open: an earlier version of
 * this function fell back to .env.local -- the same Supabase project used
 * for local dev and production -- whenever .env.test.local didn't exist,
 * meaning a missing test-project file silently turned every e2e/db test
 * into a test that mutates production data, with no error and no warning.
 * There is now exactly one source of truth for test credentials:
 * .env.test.local, or real environment variables already set before this
 * runs (CI's case -- GitHub Actions secrets land directly in process.env,
 * no file exists there at all). If neither provides the required keys,
 * this throws, and no test can proceed under an unverified configuration.
 */
export function loadEnvVars(): Record<string, string> {
  const testPath = path.resolve(dirname, "../../.env.test.local");
  const fileVars = existsSync(testPath) ? parseEnvFile(testPath) : {};

  const missing = REQUIRED_KEYS.filter(
    (key) => !(key in process.env) && !(key in fileVars),
  );
  if (missing.length > 0) {
    throw new Error(
      `e2e tests require an isolated Supabase test project, but ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. Create .env.test.local at the repo ` +
        "root with an isolated project's credentials (see e2e/README.md) -- this suite will " +
        "never fall back to .env.local (production) to avoid running destructive tests " +
        "against real data.",
    );
  }

  // An explicit empty string, not deletion: this object is also used to
  // build the spawned dev/start server's environment (playwright.config.ts),
  // a separate OS process that could otherwise inherit a real value for
  // these from whatever shell started the test run. Both Resend
  // (features/notifications/negative-feedback-alert.ts) and Sentry treat
  // an empty string as "unconfigured" the same as a genuinely absent key.
  for (const key of FORCE_DISABLED_KEYS) {
    fileVars[key] = "";
    process.env[key] = "";
  }

  return fileVars;
}

export function loadEnv(): void {
  for (const [key, value] of Object.entries(loadEnvVars())) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
