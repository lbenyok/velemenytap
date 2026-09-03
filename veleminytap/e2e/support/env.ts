import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright test files run directly under Node, not through Next.js's own
 * env loading -- so .env.local (used by `next dev`/`next build`) isn't
 * picked up automatically here. Load it by hand, same parsing this project
 * already uses in its one-off admin scripts. In CI, .env.local won't exist;
 * real env vars (from GitHub Actions secrets) take over instead.
 */
export function loadEnv(): void {
  const envPath = path.resolve(dirname, "../../.env.local");
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
