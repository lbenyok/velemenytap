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
// Usage:
//   node scripts/rollout.mjs \
//     --db-url "$PROD_DB_URL" \
//     --enforce 20260904194100_enforce_alert_cooldown_trigger.sql,20260904194500_enforce_notification_email_change_trigger.sql \
//     --expected-sha "$(git rev-parse HEAD)" \
//     --health-url https://veleminytap.vercel.app/api/health \
//     [--drain-seconds 60] [--deploy-timeout-seconds 300] [--dry-run]
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
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, "../supabase/migrations");

function parseArgs(argv) {
  const args = { drainSeconds: 60, deployTimeoutSeconds: 300, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const key = arg.replace(/^--/, "");
    const value = argv[++i];
    if (key === "db-url") args.dbUrl = value;
    else if (key === "enforce") args.enforce = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "expected-sha") args.expectedSha = value;
    else if (key === "health-url") args.healthUrl = value;
    else if (key === "drain-seconds") args.drainSeconds = Number(value);
    else if (key === "deploy-timeout-seconds") args.deployTimeoutSeconds = Number(value);
  }
  const missing = ["dbUrl", "enforce", "expectedSha", "healthUrl"].filter((k) => !args[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(", ")}. See this file's header comment for usage.`);
  }
  return args;
}

function sh(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.filter((a) => !a.includes("://")).join(" ")} [connection string redacted from log]`);
  // shell: true so this resolves npx/supabase's .cmd shim on Windows, not
  // just POSIX shells -- this is a local operator tool run by hand, not a
  // network-facing service, so the lower bar shell:true implies is
  // acceptable here.
  return execFileSync(cmd, args, { encoding: "utf-8", shell: true, ...opts });
}

function listMigrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

function getPendingMigrations(dbUrl) {
  const raw = sh("npx", ["supabase", "migration", "list", "--db-url", dbUrl, "--output-format", "json"]);
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`Expected JSON from 'supabase migration list --output-format json', got: ${raw}`);
  }
  const parsed = JSON.parse(raw.slice(jsonStart));
  return parsed.migrations
    .filter((m) => !m.remote || m.remote.trim() === "")
    .map((m) => listMigrationFiles().find((f) => f.startsWith(m.local)))
    .filter(Boolean);
}

async function pollHealth(healthUrl, expectedSha, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastBody = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { cache: "no-store" });
      const body = await res.json();
      lastBody = body;
      if (res.ok && body.ok && body.commitSha === expectedSha) {
        return body;
      }
      console.log(`  not yet -- commitSha=${body.commitSha} ok=${body.ok} (want ${expectedSha})`);
    } catch (err) {
      console.log(`  health check request failed: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for ${healthUrl} to report commit ${expectedSha}. ` +
      `Last response: ${JSON.stringify(lastBody)}. This does not necessarily mean the deployment is ` +
      "broken -- check the Vercel Deployments dashboard directly. Refusing to apply the enforce " +
      "migrations against unverified application code.",
  );
}

function applyExpandMigrations(dbUrl, enforceList, dryRun) {
  const pending = getPendingMigrations(dbUrl);
  const pendingEnforce = pending.filter((f) => enforceList.includes(f));
  const pendingExpand = pending.filter((f) => !enforceList.includes(f));

  console.log(`Pending migrations: ${pending.length} total (${pendingExpand.length} expand, ${pendingEnforce.length} enforce)`);
  if (pendingExpand.length === 0) {
    console.log("No expand migrations pending -- skipping this phase.");
    return;
  }

  const stagingDir = mkdtempSync(path.join(tmpdir(), "rollout-enforce-staging-"));
  const moved = [];
  try {
    for (const file of pendingEnforce) {
      renameSync(path.join(migrationsDir, file), path.join(stagingDir, file));
      moved.push(file);
    }
    console.log(`Staged ${moved.length} enforce migration(s) out of the way: ${moved.join(", ") || "(none)"}`);

    if (dryRun) {
      sh("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--dry-run"]);
    } else {
      sh("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--yes"]);
    }
  } finally {
    for (const file of moved) {
      renameSync(path.join(stagingDir, file), path.join(migrationsDir, file));
    }
    rmSync(stagingDir, { recursive: true, force: true });
    console.log(`Restored ${moved.length} staged migration file(s) to supabase/migrations/.`);
  }
}

function applyEnforceMigrations(dbUrl, dryRun) {
  const pending = getPendingMigrations(dbUrl);
  if (pending.length === 0) {
    console.log("No migrations pending -- nothing to enforce.");
    return;
  }
  console.log(`Applying ${pending.length} remaining (enforce) migration(s): ${pending.join(", ")}`);
  if (dryRun) {
    sh("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--dry-run"]);
  } else {
    sh("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--yes"]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Phase 1: apply expand migrations ===");
  applyExpandMigrations(args.dbUrl, args.enforce, args.dryRun);

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
  applyEnforceMigrations(args.dbUrl, args.dryRun);

  console.log("\n=== Phase 6: final verification ===");
  const stillPending = getPendingMigrations(args.dbUrl);
  if (stillPending.length > 0) {
    throw new Error(`Rollout finished but migrations are still pending: ${stillPending.join(", ")}`);
  }
  console.log("All migrations applied. Rollout complete.");
}

main().catch((err) => {
  console.error(`\nROLLOUT FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
