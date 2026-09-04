import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright test files run directly under Node, not through Next.js's own
 * env loading -- so an .env file isn't picked up automatically here. Load
 * it by hand, same parsing this project already uses in its one-off admin
 * scripts. In CI, neither file will exist; real env vars (from GitHub
 * Actions secrets) take over instead.
 *
 * .env.test.local (an isolated Supabase test project -- see e2e/README.md)
 * is preferred over .env.local (the same project used for local dev and
 * production) so e2e/db tests never run against production data.
 */
export function loadEnvVars(): Record<string, string> {
  const testPath = path.resolve(dirname, "../../.env.test.local");
  const envPath = existsSync(testPath) ? testPath : path.resolve(dirname, "../../.env.local");
  if (!existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) vars[key] = value;
  }
  return vars;
}

export function loadEnv(): void {
  for (const [key, value] of Object.entries(loadEnvVars())) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
