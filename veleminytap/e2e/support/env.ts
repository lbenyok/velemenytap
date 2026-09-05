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

// The isolated Supabase project this suite is allowed to run against
// (round-3 finding R3-01: credential *presence* isn't proof the project is
// safe -- a complete, well-formed, syntactically valid set of production
// credentials sitting in a developer's shell would pass every other check
// here). This is the project-ref segment of NEXT_PUBLIC_SUPABASE_URL
// (https://<ref>.supabase.co) for the dedicated e2e project documented in
// e2e/README.md -- not a secret; it's the same string already public in
// every request this app's own browser client makes.
// Exported for reuse by e2e/support/db-connection.ts (round-4 R4-04),
// which needs to validate SUPABASE_DB_URL against the same allowlist.
export const APPROVED_TEST_PROJECT_REF = "nowcuhwgeerzqlpweyxj";

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

function hasAllRequiredKeys(source: Record<string, string | undefined>): boolean {
  return REQUIRED_KEYS.every((key) => typeof source[key] === "string" && source[key] !== "");
}

function projectRefFromUrl(url: string): string | null {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

/**
 * Resolves e2e credentials from exactly ONE canonical source -- either a
 * fully-populated .env.test.local file, or a fully-populated process
 * environment (CI's case: GitHub Actions secrets land directly in
 * process.env, no file exists in the checkout at all) -- never a mix.
 *
 * Round-3 finding R3-01: the previous version checked each required key
 * against "is it in process.env OR the file" independently, then always
 * returned only the file's contents. Two real bugs followed: (1) in CI,
 * where credentials exist only in process.env, the file doesn't exist, so
 * the per-key presence check passed (every key was "found", just via
 * process.env) but the returned object was missing all three keys anyway
 * -- this is exactly what broke playwright.config.ts's globalSetup, which
 * reads loadEnvVars().NEXT_PUBLIC_SUPABASE_URL and got undefined, failing
 * the run before a single test executed. (2) locally, if a developer had
 * production values already exported in their shell alongside a complete
 * .env.test.local, values from the two sources could silently blend
 * depending on which key happened to already exist in process.env.
 *
 * The file wins if it's complete (it's the explicit artifact created
 * specifically for this purpose, per e2e/README.md); process.env is used
 * only when the file doesn't exist or isn't complete on its own. A source
 * that's present but only partially complete is never silently topped up
 * from the other -- that's the "mixed source" case this guards against.
 */
function resolveCredentialSource(): { source: "file" | "process"; vars: Record<string, string> } {
  const testPath = path.resolve(dirname, "../../.env.test.local");
  const fileVars = existsSync(testPath) ? parseEnvFile(testPath) : {};

  if (hasAllRequiredKeys(fileVars)) {
    return {
      source: "file",
      vars: Object.fromEntries(REQUIRED_KEYS.map((key) => [key, fileVars[key]])),
    };
  }

  if (hasAllRequiredKeys(process.env)) {
    return {
      source: "process",
      vars: Object.fromEntries(REQUIRED_KEYS.map((key) => [key, process.env[key] as string])),
    };
  }

  const fileHasSome = REQUIRED_KEYS.some((key) => key in fileVars);
  const processHasSome = REQUIRED_KEYS.some((key) => key in process.env && process.env[key] !== "");
  const mixedHint =
    fileHasSome && processHasSome
      ? " .env.test.local and the process environment each supply only SOME of the required keys -- " +
        "this suite refuses to combine a partial file with a partial process environment; put every " +
        "required key in exactly one place. "
      : " ";

  throw new Error(
    `e2e tests require an isolated Supabase test project, but neither .env.test.local nor the ` +
      `process environment fully supplies ${REQUIRED_KEYS.join(", ")}.${mixedHint}Create ` +
      ".env.test.local at the repo root with an isolated project's credentials (see e2e/README.md) " +
      "-- this suite will never fall back to .env.local (production) to avoid running destructive " +
      "tests against real data.",
  );
}

/**
 * Resolves e2e credentials from exactly one canonical source (see
 * resolveCredentialSource above), validates the resolved project against
 * an explicit allowlist (round-3 R3-01: a complete, well-formed,
 * syntactically valid *production* credential set would otherwise pass
 * every check above too -- presence and completeness are not the same
 * thing as "this is the right project"), force-disables Resend/Sentry for
 * the run, and overwrites (not merely fills gaps in) process.env with the
 * resolved values -- so the current test process and the spawned
 * Playwright server (playwright.config.ts's webServer.env) are guaranteed
 * to agree, even if a stale, different value for one of these keys was
 * already sitting in process.env for an unrelated reason.
 */
export function loadEnvVars(): Record<string, string> {
  const { vars } = resolveCredentialSource();

  const projectRef = projectRefFromUrl(vars.NEXT_PUBLIC_SUPABASE_URL);
  if (projectRef !== APPROVED_TEST_PROJECT_REF) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL ("${vars.NEXT_PUBLIC_SUPABASE_URL}") does not resolve to the ` +
        `approved isolated e2e test project (expected project ref "${APPROVED_TEST_PROJECT_REF}"). ` +
        "Refusing to run -- this is very likely production or an unrecognized project. See " +
        "e2e/README.md for how to point this suite at the correct isolated project.",
    );
  }

  const resolved: Record<string, string> = { ...vars };
  for (const key of FORCE_DISABLED_KEYS) {
    resolved[key] = "";
  }

  // Overwrite, not "set only if absent": a stale value already in
  // process.env (e.g. a developer's shell exporting something unrelated)
  // must not silently outrank the canonical resolved value anywhere this
  // runs -- the test process and the spawned server must see identical
  // values for every one of these keys.
  for (const [key, value] of Object.entries(resolved)) {
    process.env[key] = value;
  }

  return resolved;
}

export function loadEnv(): void {
  loadEnvVars();
}
