#!/usr/bin/env node
// Round-4 finding R4-03. Replaces the manual round-2/round-3 rollout
// procedure (temporarily move the "enforce" migration files out of
// supabase/migrations by hand, run `supabase db push`, restore them,
// eyeball the Vercel dashboard to decide whether the new code is live,
// apply the enforce migrations) with a single scripted, self-verifying
// sequence. The manual version's actual failure was never the file-moving
// mechanism itself -- it was applying the enforce migrations on an
// ASSUMPTION about deployment status that turned out to be wrong (Vercel's
// Git webhook had silently stopped firing), with nothing to catch that.
// This script still moves files the same way (reusing `supabase db push`,
// not reimplementing Postgres migration bookkeeping), but every phase
// transition is gated on an automated check against the live /api/health
// endpoint (see app/api/health/route.ts) -- it refuses to proceed, rather
// than proceeding on faith, if the expected commit isn't actually live.
//
// Round-5 findings R5-03/R5-04/R5-05 hardened this significantly:
//   - Both --expand and --enforce are now required, explicit, exact
//     manifests of every migration expected to be pending -- a typo in
//     either, a name that doesn't exist, one that's already applied, or a
//     pending migration neither list accounts for, all abort immediately
//     (before touching the database), instead of an unrecognized
//     migration silently falling into whichever phase happens to run
//     first.
//   - --health-url must be an exact match for --allowed-origin (defaults
//     to this project's real production origin) and the response's own
//     `environment` field must read "production" -- a fake/compromised
//     health server can no longer authorize a production migration by
//     satisfying just `ok`+`commitSha`.
//   - No more shell:true (a real command-injection surface given --db-url
//     carries a password this script doesn't control the contents of).
//
// Usage:
//   node scripts/rollout.mjs \
//     --db-url "$PROD_DB_URL" \
//     --expand 20260904194200_validate_analytics_period_days.sql,20260904194300_restrict_service_role_and_enable_alert_log_rls.sql,20260904194400_notification_email_verification.sql \
//     --enforce 20260904194100_enforce_alert_cooldown_trigger.sql,20260904194500_enforce_notification_email_change_trigger.sql \
//     --expected-sha "$(git rev-parse HEAD)" \
//     --health-url https://veleminytap.vercel.app/api/health \
//     [--allowed-origin https://veleminytap.vercel.app] \
//     [--drain-seconds 60] [--deploy-timeout-seconds 300] [--dry-run]
//
// Either list may be passed as an empty string (--expand "") if that
// phase genuinely has nothing pending -- but the flag itself must always
// be given, so "I forgot to list something" and "there's genuinely
// nothing" are never the same code path.
//
// Exits non-zero and leaves the database in whatever state the last
// successfully-completed phase left it in if any gate fails -- it never
// silently continues past a failed check. Does not deploy or merge
// anything itself; it assumes the commit named by --expected-sha has
// already been pushed to the branch Vercel deploys from, and only WAITS
// for that deployment to become live before proceeding.
import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, "../supabase/migrations");
const DEFAULT_ALLOWED_ORIGIN = "https://veleminytap.vercel.app";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function parseMigrationList(value, flagName) {
  if (value === undefined) {
    throw new Error(`Missing required argument: --${flagName}. Pass an empty string if genuinely none are pending.`);
  }
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  for (const name of list) {
    if (seen.has(name)) {
      throw new Error(`--${flagName} lists "${name}" more than once.`);
    }
    seen.add(name);
  }
  return list;
}

export function parseArgs(argv) {
  const args = {
    drainSeconds: 60,
    deployTimeoutSeconds: 300,
    dryRun: false,
    allowedOrigin: DEFAULT_ALLOWED_ORIGIN,
    dbUrl: /** @type {string} */ (""),
    expand: /** @type {string[]} */ ([]),
    enforce: /** @type {string[]} */ ([]),
    expectedSha: /** @type {string} */ (""),
    healthUrl: /** @type {string} */ (""),
  };
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const key = arg.replace(/^--/, "");
    const value = argv[++i];
    raw[key] = value;
  }

  if (!raw["db-url"]) throw new Error("Missing required argument: --db-url");
  args.dbUrl = raw["db-url"];

  args.expand = parseMigrationList(raw["expand"], "expand");
  args.enforce = parseMigrationList(raw["enforce"], "enforce");
  for (const name of args.expand) {
    if (args.enforce.includes(name)) {
      throw new Error(`"${name}" is listed in both --expand and --enforce -- a migration can only be one or the other.`);
    }
  }

  if (!raw["expected-sha"]) throw new Error("Missing required argument: --expected-sha");
  if (!/^[0-9a-f]{7,40}$/i.test(raw["expected-sha"])) {
    throw new Error(`--expected-sha "${raw["expected-sha"]}" doesn't look like a git commit SHA (expected 7-40 hex characters).`);
  }
  args.expectedSha = raw["expected-sha"];

  if (raw["allowed-origin"] !== undefined) args.allowedOrigin = raw["allowed-origin"];
  let allowedOriginUrl;
  try {
    allowedOriginUrl = new URL(args.allowedOrigin);
  } catch {
    throw new Error(`--allowed-origin "${args.allowedOrigin}" is not a valid URL.`);
  }
  if (allowedOriginUrl.protocol !== "https:") {
    throw new Error(`--allowed-origin must be https:// -- got "${args.allowedOrigin}".`);
  }

  if (!raw["health-url"]) throw new Error("Missing required argument: --health-url");
  let healthUrl;
  try {
    healthUrl = new URL(raw["health-url"]);
  } catch {
    throw new Error(`--health-url "${raw["health-url"]}" is not a valid URL.`);
  }
  // Round-5 R5-05: this check used to accept any URL the caller supplied,
  // with no restriction at all -- a compromised or merely misconfigured
  // caller could point a real rollout at an attacker-controlled health
  // server that trivially satisfies `ok`+`commitSha`, authorizing
  // production database writes. Requiring an exact origin match (not just
  // "https", not just "same hostname" -- the full scheme+host+port) means
  // this script only ever trusts the one server it's explicitly
  // configured to trust.
  if (healthUrl.origin !== allowedOriginUrl.origin) {
    throw new Error(
      `--health-url's origin ("${healthUrl.origin}") does not match --allowed-origin ("${allowedOriginUrl.origin}"). ` +
        "Refusing to poll an unexpected origin for a production rollout decision.",
    );
  }
  args.healthUrl = raw["health-url"];

  for (const [flag, key] of [
    ["drain-seconds", "drainSeconds"],
    ["deploy-timeout-seconds", "deployTimeoutSeconds"],
  ]) {
    if (raw[flag] === undefined) continue;
    const n = Number(raw[flag]);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`--${flag} must be a finite, non-negative number -- got "${raw[flag]}".`);
    }
    args[key] = n;
  }

  return args;
}

/**
 * Round-5 R5-03/R5-04: validates the EXACT set of pending migrations
 * against explicit --expand/--enforce manifests before anything is
 * applied. This is what actually catches a typo -- e.g. a misspelled
 * --enforce filename means the real (correctly-named) pending enforce
 * migration is accounted for in NEITHER list, so it's flagged here as
 * "unexpected pending migration" and the whole run aborts, rather than
 * silently falling into the expand phase because "not in --enforce" used
 * to be treated as "must be expand."
 */
export function validateMigrationPlan(pending, expandList, enforceList, allFiles) {
  const allFilesSet = new Set(allFiles);
  const pendingSet = new Set(pending);
  const plannedSet = new Set([...expandList, ...enforceList]);

  for (const [flagName, list] of [
    ["expand", expandList],
    ["enforce", enforceList],
  ]) {
    for (const name of list) {
      if (!allFilesSet.has(name)) {
        throw new Error(`--${flagName} names "${name}", which does not exist in supabase/migrations/.`);
      }
      if (!pendingSet.has(name)) {
        throw new Error(
          `--${flagName} names "${name}", but it is not currently pending against this database (already applied, ` +
            "or the migration-history bookkeeping is out of sync -- check `supabase migration list`).",
        );
      }
    }
  }

  const unaccounted = pending.filter((name) => !plannedSet.has(name));
  if (unaccounted.length > 0) {
    throw new Error(
      `${unaccounted.length} pending migration(s) are not listed in --expand or --enforce: ${unaccounted.join(", ")}. ` +
        "Refusing to guess which phase they belong to -- name every pending migration explicitly.",
    );
  }
}

function sh(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.filter((a) => !a.includes("://")).join(" ")} [connection string redacted from log]`);
  return execFileSync(cmd, args, { encoding: "utf-8", ...opts });
}

function listMigrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

function getPendingMigrations(dbUrl) {
  const raw = sh(NPX, ["supabase", "migration", "list", "--db-url", dbUrl, "--output-format", "json"]);
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`Expected JSON from 'supabase migration list --output-format json', got: ${raw}`);
  }
  const parsed = JSON.parse(raw.slice(jsonStart));
  const knownFiles = listMigrationFiles();
  return parsed.migrations
    .filter((m) => !m.remote || m.remote.trim() === "")
    .map((m) => {
      // Round-5 R5-04: this used to be `.find(...) ` piped straight into
      // `.filter(Boolean)` -- an unrecognized local version silently
      // vanished from the result instead of being surfaced, so it could
      // disappear from both "what will phase 1 apply" and "did phase 6's
      // final check actually cover everything."
      const file = knownFiles.find((f) => f.startsWith(m.local));
      if (!file) {
        throw new Error(
          `'supabase migration list' reports a pending migration version "${m.local}" that doesn't match any file ` +
            "in supabase/migrations/ -- refusing to silently drop it from the plan.",
        );
      }
      return file;
    });
}

async function pollHealth(healthUrl, expectedSha, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastBody = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { cache: "no-store" });
      const body = await res.json();
      lastBody = body;
      // Round-5 R5-05: also requires environment === "production" now,
      // not just ok+commitSha -- a health response is otherwise only as
      // trustworthy as whatever server answered --health-url, and ok:true
      // with a matching SHA is a low bar for something about to authorize
      // writes to a real production database.
      if (res.ok && body.ok && body.commitSha === expectedSha && body.environment === "production") {
        return body;
      }
      console.log(
        `  not yet -- commitSha=${body.commitSha} ok=${body.ok} environment=${body.environment} (want ${expectedSha}, production)`,
      );
    } catch (err) {
      console.log(`  health check request failed: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for ${healthUrl} to report commit ${expectedSha} in production. ` +
      `Last response: ${JSON.stringify(lastBody)}. This does not necessarily mean the deployment is ` +
      "broken -- check the Vercel Deployments dashboard directly. Refusing to apply the enforce " +
      "migrations against unverified application code.",
  );
}

function applyExpandMigrations(dbUrl, expandList, enforceList, dryRun) {
  if (expandList.length === 0) {
    console.log("No expand migrations to apply -- skipping this phase.");
    return;
  }

  const stagingDir = mkdtempSync(path.join(tmpdir(), "rollout-enforce-staging-"));
  const moved = [];
  try {
    for (const file of enforceList) {
      renameSync(path.join(migrationsDir, file), path.join(stagingDir, file));
      moved.push(file);
    }
    console.log(`Staged ${moved.length} enforce migration(s) out of the way: ${moved.join(", ") || "(none)"}`);

    // Round-5 R5-04: --include-all is required whenever an already-staged
    // -out enforce migration's timestamp sorts earlier than one that gets
    // applied while it's out of the way -- this is not hypothetical, it's
    // exactly what happened applying this project's own round-2/3 enforce
    // migrations in production (STATUS.md). Without it, `supabase db
    // push` refuses to apply an out-of-order migration at all.
    const pushArgs = ["supabase", "db", "push", "--db-url", dbUrl, "--include-all"];
    if (dryRun) pushArgs.push("--dry-run");
    else pushArgs.push("--yes");
    sh(NPX, pushArgs);
  } finally {
    for (const file of moved) {
      renameSync(path.join(stagingDir, file), path.join(migrationsDir, file));
    }
    rmSync(stagingDir, { recursive: true, force: true });
    console.log(`Restored ${moved.length} staged migration file(s) to supabase/migrations/.`);
  }

  if (dryRun) return;

  // Verify the exact expected residual: everything named in --expand is
  // now applied, and nothing else moved -- pending should be exactly
  // enforceList, no more, no less.
  const stillPending = new Set(getPendingMigrations(dbUrl));
  const enforceSet = new Set(enforceList);
  const unexpectedlyApplied = enforceList.filter((f) => !stillPending.has(f));
  const unexpectedlyPending = [...stillPending].filter((f) => !enforceSet.has(f));
  if (unexpectedlyApplied.length > 0) {
    throw new Error(`Expand phase unexpectedly applied enforce migration(s): ${unexpectedlyApplied.join(", ")}.`);
  }
  if (unexpectedlyPending.length > 0) {
    throw new Error(
      `After the expand phase, ${unexpectedlyPending.length} migration(s) are pending that aren't in --enforce: ` +
        `${unexpectedlyPending.join(", ")}. Aborting before the enforce phase would apply them unreviewed.`,
    );
  }
}

function applyEnforceMigrations(dbUrl, enforceList, dryRun) {
  if (enforceList.length === 0) {
    console.log("No enforce migrations to apply -- nothing to enforce.");
    return;
  }

  const pendingBefore = new Set(getPendingMigrations(dbUrl));
  const missing = enforceList.filter((f) => !pendingBefore.has(f));
  if (missing.length > 0) {
    throw new Error(`Expected to enforce ${missing.join(", ")}, but they are no longer pending.`);
  }
  const extra = [...pendingBefore].filter((f) => !enforceList.includes(f));
  if (extra.length > 0) {
    throw new Error(
      `${extra.length} migration(s) are pending that aren't in --enforce: ${extra.join(", ")}. Refusing to apply ` +
        "them alongside the reviewed enforce set.",
    );
  }

  console.log(`Applying ${enforceList.length} enforce migration(s): ${enforceList.join(", ")}`);
  const pushArgs = ["supabase", "db", "push", "--db-url", dbUrl, "--include-all"];
  if (dryRun) pushArgs.push("--dry-run");
  else pushArgs.push("--yes");
  sh(NPX, pushArgs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Phase 0: validate the migration plan against the database ===");
  const pendingAtStart = getPendingMigrations(args.dbUrl);
  console.log(`Pending: ${pendingAtStart.length} total (${args.expand.length} expand, ${args.enforce.length} enforce planned)`);
  validateMigrationPlan(pendingAtStart, args.expand, args.enforce, listMigrationFiles());
  console.log("Plan matches the database exactly: every pending migration is accounted for.");

  console.log("\n=== Phase 1: apply expand migrations ===");
  applyExpandMigrations(args.dbUrl, args.expand, args.enforce, args.dryRun);

  if (args.dryRun) {
    console.log("\n--dry-run: stopping after phase 1 (no deployment to wait for, nothing to enforce).");
    return;
  }

  console.log("\n=== Phase 2: wait for the expected commit to be live in production ===");
  console.log(`Polling ${args.healthUrl} for commitSha=${args.expectedSha} (timeout ${args.deployTimeoutSeconds}s)...`);
  await pollHealth(args.healthUrl, args.expectedSha, args.deployTimeoutSeconds);
  console.log("Confirmed: production is serving the expected commit.");

  console.log(`\n=== Phase 3: drain window (${args.drainSeconds}s) ===`);
  await new Promise((resolve) => setTimeout(resolve, args.drainSeconds * 1000));

  console.log("\n=== Phase 4: compatibility smoke check ===");
  const health = await pollHealth(args.healthUrl, args.expectedSha, 30);
  console.log(`Smoke check passed: ${JSON.stringify(health)}`);

  console.log("\n=== Phase 5: apply enforce migrations ===");
  applyEnforceMigrations(args.dbUrl, args.enforce, args.dryRun);

  console.log("\n=== Phase 6: final verification ===");
  const stillPending = getPendingMigrations(args.dbUrl);
  if (stillPending.length > 0) {
    throw new Error(`Rollout finished but migrations are still pending: ${stillPending.join(", ")}`);
  }
  console.log("All migrations applied. Rollout complete.");
}

// Only run when executed directly (`node scripts/rollout.mjs ...`), not
// when imported for unit testing pure functions like parseArgs/
// validateMigrationPlan. See scripts/check-e2e-secrets.mjs for the same
// pattern and why a naive `file://${process.argv[1]}` comparison doesn't
// work (argv[1] is relative in the normal invocation form).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nROLLOUT FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
