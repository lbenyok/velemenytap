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
//   - The health URL polled and the `environment` value required in its
//     response are no longer caller-supplied at all -- see round-6 R6-07
//     below, which replaced this with --target/rollout-environments.json.
//   - No more shell:true (a real command-injection surface given --db-url
//     carries a password this script doesn't control the contents of).
//
// Round-6 finding R6-07: --allowed-origin and --health-url used to be
// caller-supplied arguments, cross-checked only against EACH OTHER (round-5
// R5-05) -- which proves nothing about whether --db-url actually points at
// the database belonging to that same application. --target now selects a
// fixed, committed, reviewed entry from rollout-environments.json binding
// the Supabase project ref, the application's exact origin, its health URL,
// and its expected `environment` value together.
//
// Found during an independent review, after this script's own single-
// command design nearly caused a real production incident: the original
// usage assumed the caller already knew --expected-sha BEFORE running
// anything, because the script's own phase 1 (apply expand migrations)
// happened AFTER that commit was supposed to already be live. Two real
// problems followed from that:
//   1. THE RACE: Vercel's automatic deploy from `master` starts the moment
//      a merge lands, completely independent of whether or when this
//      script happens to run. If the operator merges first and only then
//      starts this script, the new application code -- which reads a
//      column an expand migration hasn't added yet -- can go live before
//      phase 1 even begins, breaking every request that touches it. There
//      is no Vercel Deployment Check configured to make Vercel wait for
//      anything (see DEPLOYMENT.md); nothing external prevents this.
//   2. THE WRONG SHA: a squash merge (or an ordinary merge commit) produces
//      a brand-new commit SHA on `master`, different from the PR branch's
//      own HEAD. Pre-computing --expected-sha from the branch before
//      merging names a commit that will never actually appear in
//      /api/health's response -- the script would poll until
//      --deploy-timeout-seconds expired and fail, even against a
//      perfectly healthy deployment, just checking the wrong value.
//
// Fixed by splitting the single command into two, run at genuinely
// different times, with the merge/deploy happening in between:
//
//   node scripts/rollout.mjs prepare \
//     --target production \
//     --db-url "$PRODUCTION_DB_URL" \
//     --expand 20260905193325_....sql,20260906110000_....sql,20260906120000_....sql,20260906130000_....sql \
//     --enforce 20260906090000_....sql,20260906100000_....sql \
//     [--dry-run]
//
//   -- prepare applies ONLY the expand migrations (safe by construction:
//   expand migrations are additive/backward-compatible, so applying them
//   before any new code deploys never breaks the currently-live old code)
//   and verifies exactly the --enforce set remains pending. It needs no
//   commit SHA at all, and is therefore safe to run BEFORE merging --
//   which is the whole point: by the time the merge happens and Vercel
//   starts deploying, the column/function/trigger the new code depends on
//   already exists. This closes the race in problem 1 by construction,
//   not by timing the two scripts more carefully.
//
//   -- the owner then merges/deploys by hand, through GitHub/Vercel as
//   normal, and reads the ACTUAL resulting `master` SHA back from GitHub
//   (e.g. `git rev-parse origin/master` after the merge, or the merge
//   commit GitHub reports) -- never a SHA computed before the merge
//   happened, which solves problem 2: the value passed to finalize is
//   never speculative.
//
//   -- BEFORE running finalize, APP_ENV must already be set in Vercel for
//   this target's environment (Project Settings -> Environment Variables,
//   see DEPLOYMENT.md § 3). This is a REQUIRED human prerequisite, not an
//   optional nicety: /api/health returns 503 (ok:false) without it, and
//   finalize's own health poll can never succeed against a 503 -- it isn't
//   something this script can set or detect in advance, only wait on and
//   eventually time out against, less helpfully than simply doing it first.
//
//   node scripts/rollout.mjs finalize \
//     --target production \
//     --db-url "$PRODUCTION_DB_URL" \
//     --enforce 20260906090000_....sql,20260906100000_....sql \
//     --expected-sha "<the ACTUAL resulting master SHA, read after merging>" \
//     [--drain-seconds 60] [--deploy-timeout-seconds 300] [--dry-run]
//
//   -- finalize FIRST verifies that only the --enforce migrations are
//   still pending (refusing outright if any expand migration is still
//   pending -- that means prepare was never run, ran against a different
//   database, or something else is wrong; finalize will not guess), then
//   waits for /api/health to report --expected-sha in the target's
//   expected environment, drains, re-checks, and only then applies the
//   enforce migrations.
//
// Both phases are safely resumable: re-running `prepare` after it already
// fully (or partially) succeeded is a no-op for whatever already applied
// and simply finishes whatever didn't -- it never demands that an expand
// migration still be pending just because that's what a fresh run would
// see. Re-running `finalize` after it already fully succeeded is likewise
// a no-op (nothing pending, nothing to apply) rather than an error. What
// remains a hard failure in both phases is anything UNEXPECTED being
// pending or already-applied -- an --enforce migration that's somehow
// already gone during prepare (enforce migrations are staged out of the
// directory before prepare's own `db push` runs, so this can only mean
// something touched it out of band), or anything pending during finalize
// that isn't in --enforce (an expand migration that never finished, or an
// unplanned migration neither phase accounted for).
//
// Either list may be passed as an empty string (--expand "" / --enforce "")
// if that phase genuinely has nothing pending -- but the flag itself must
// always be given to prepare/finalize respectively, so "I forgot to list
// something" and "there's genuinely nothing" are never the same code path.
//
// Exits non-zero and leaves the database in whatever state the last
// successfully-completed step left it in if any gate fails -- it never
// silently continues past a failed check. Neither phase deploys or merges
// anything itself.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, "../supabase/migrations");
const environmentsPath = path.resolve(dirname, "rollout-environments.json");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Round-7 finding R7-04 (MEDIUM): allowedOrigin was stored but never
 * actually checked against anything -- healthUrl could name a different
 * origin entirely and nothing here would notice, making allowedOrigin
 * dead metadata rather than the enforced control its own name implies.
 * Validated strictly here, at manifest-load time, so a malformed or
 * internally-inconsistent entry is caught before any rollout phase ever
 * reads it.
 */
export function loadEnvironments(raw) {
  const parsed = JSON.parse(raw);
  for (const [name, env] of Object.entries(parsed)) {
    for (const key of ["supabaseProjectRef", "allowedOrigin", "healthUrl", "environment"]) {
      if (typeof env[key] !== "string" || !env[key]) {
        throw new Error(`rollout-environments.json's "${name}" entry is missing a valid "${key}".`);
      }
    }

    let allowedOriginUrl;
    try {
      allowedOriginUrl = new URL(env.allowedOrigin);
    } catch {
      throw new Error(`rollout-environments.json's "${name}".allowedOrigin ("${env.allowedOrigin}") is not a valid URL.`);
    }
    if (allowedOriginUrl.protocol !== "https:") {
      throw new Error(`rollout-environments.json's "${name}".allowedOrigin must be https:// -- got "${env.allowedOrigin}".`);
    }

    let healthUrl;
    try {
      healthUrl = new URL(env.healthUrl);
    } catch {
      throw new Error(`rollout-environments.json's "${name}".healthUrl ("${env.healthUrl}") is not a valid URL.`);
    }
    if (healthUrl.protocol !== "https:") {
      throw new Error(`rollout-environments.json's "${name}".healthUrl must be https:// -- got "${env.healthUrl}".`);
    }
    // The actual enforcement this finding asked for: healthUrl's origin
    // must match this same entry's own allowedOrigin -- not just be
    // printed alongside it.
    if (healthUrl.origin !== allowedOriginUrl.origin) {
      throw new Error(
        `rollout-environments.json's "${name}" has a healthUrl origin ("${healthUrl.origin}") that does not match ` +
          `its own allowedOrigin ("${allowedOriginUrl.origin}") -- these must agree.`,
      );
    }
    if (healthUrl.username || healthUrl.password) {
      throw new Error(`rollout-environments.json's "${name}".healthUrl must not carry credentials.`);
    }
    if (healthUrl.hash) {
      throw new Error(`rollout-environments.json's "${name}".healthUrl must not carry a fragment.`);
    }
    if (healthUrl.search) {
      throw new Error(`rollout-environments.json's "${name}".healthUrl must not carry a query string.`);
    }
  }
  return parsed;
}

/**
 * Deliberately duplicated, minimal re-implementation of
 * e2e/support/db-connection.ts's projectRefFromDbUrl() -- that file is
 * TypeScript, imported elsewhere only through a test runner/bundler that
 * transpiles it, and this script runs directly under plain `node` with no
 * build step. Extracts the ref only from the hostname (direct connection)
 * or the decoded username (pooler connection), the one component each
 * connection form actually authenticates against -- never the path, query
 * string, password, or fragment, all of which a client fully controls and
 * none of which the server checks. Keep in sync with db-connection.ts if
 * either changes.
 */
export function projectRefFromDbUrl(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const directMatch = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(hostname);
  if (directMatch) {
    return directMatch[1];
  }
  if (/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)) {
    let username;
    try {
      username = decodeURIComponent(url.username);
    } catch {
      return null;
    }
    const usernameMatch = /^postgres\.([a-z0-9]+)$/.exec(username);
    if (usernameMatch) {
      return usernameMatch[1];
    }
  }
  return null;
}

const COMMON_FLAGS = new Set(["db-url", "target"]);
const PREPARE_ONLY_FLAGS = new Set(["expand", "enforce"]);
const FINALIZE_ONLY_FLAGS = new Set(["enforce", "expected-sha", "drain-seconds", "deploy-timeout-seconds"]);
const REMOVED_FLAGS = new Set(["allowed-origin", "health-url"]);

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

/**
 * Found during an independent review (see this file's own header comment
 * for the full incident this closes): the original single-command design
 * required --expected-sha to already be known before the migration this
 * whole invocation exists to protect against had even happened. Split
 * into two commands, `prepare` and `finalize`, run at genuinely different
 * times with the merge/deploy happening in between -- each accepts and
 * requires only the arguments that make sense for what it actually does.
 */
export function parseArgs(argv, environments) {
  const command = argv[0];
  if (command !== "prepare" && command !== "finalize") {
    throw new Error(
      `First argument must be "prepare" or "finalize" -- got ${command ? `"${command}"` : "nothing"}. ` +
        "See this script's own header comment for the full two-phase workflow and why it's split this way.",
    );
  }
  const commandFlags = command === "prepare"
    ? new Set([...COMMON_FLAGS, ...PREPARE_ONLY_FLAGS])
    : new Set([...COMMON_FLAGS, ...FINALIZE_ONLY_FLAGS]);
  const otherCommandOnlyFlags = command === "prepare" ? FINALIZE_ONLY_FLAGS : PREPARE_ONLY_FLAGS;

  const args = {
    command,
    drainSeconds: 60,
    deployTimeoutSeconds: 300,
    dryRun: false,
    dbUrl: /** @type {string} */ (""),
    expand: /** @type {string[]} */ ([]),
    enforce: /** @type {string[]} */ ([]),
    expectedSha: /** @type {string} */ (""),
    target: /** @type {string} */ (""),
    allowedOrigin: /** @type {string} */ (""),
    healthUrl: /** @type {string} */ (""),
    supabaseProjectRef: /** @type {string} */ (""),
    environment: /** @type {string} */ (""),
  };
  const raw = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}" -- every argument after the command must be a --flag.`);
    }
    const key = arg.replace(/^--/, "");
    if (!commandFlags.has(key)) {
      let hint = "";
      if (REMOVED_FLAGS.has(key)) {
        hint = " This flag was removed (round-6 R6-07) -- --target now selects both this and the origin from the committed rollout-environments.json manifest.";
      } else if (otherCommandOnlyFlags.has(key)) {
        hint = ` --${key} belongs to "${command === "prepare" ? "finalize" : "prepare"}", not "${command}".`;
      }
      throw new Error(
        `Unknown argument --${key} for "${command}".${hint} Known arguments for "${command}": --dry-run, ${[...commandFlags].map((f) => `--${f}`).join(", ")}.`,
      );
    }
    const value = argv[++i];
    raw[key] = value;
  }

  if (!raw["db-url"]) throw new Error("Missing required argument: --db-url");
  args.dbUrl = raw["db-url"];

  if (command === "prepare") {
    args.expand = parseMigrationList(raw["expand"], "expand");
    args.enforce = parseMigrationList(raw["enforce"], "enforce");
    for (const name of args.expand) {
      if (args.enforce.includes(name)) {
        throw new Error(`"${name}" is listed in both --expand and --enforce -- a migration can only be one or the other.`);
      }
    }
  } else {
    args.enforce = parseMigrationList(raw["enforce"], "enforce");

    if (!raw["expected-sha"]) throw new Error("Missing required argument: --expected-sha");
    // Round-6 finding R6-11: this used to accept 7-40 hex characters, but
    // /api/health's own commitSha is always the FULL 40-character SHA
    // (VERCEL_GIT_COMMIT_SHA), and pollHealth compares it with exact string
    // equality -- a short SHA can never match, but that failure was only
    // ever discovered after phase 1 (the expand migrations) had already run
    // and the full deploy-timeout had elapsed. Requiring the full SHA here
    // catches a short --expected-sha immediately. The caller already has
    // the ACTUAL post-merge SHA trivially available ($(git rev-parse
    // origin/master) after merging, never the pre-merge branch HEAD -- see
    // this file's own header comment for why those two are not the same
    // value).
    if (!/^[0-9a-f]{40}$/i.test(raw["expected-sha"])) {
      throw new Error(
        `--expected-sha "${raw["expected-sha"]}" must be a full 40-character git commit SHA, not a short/abbreviated ` +
          "one -- /api/health always reports the full SHA and this script compares it exactly. Use the ACTUAL " +
          'resulting SHA on the target branch after merging/deploying, e.g. "$(git rev-parse origin/master)" -- ' +
          "never a SHA computed before the merge, which a squash or merge commit will not match.",
      );
    }
    args.expectedSha = raw["expected-sha"];

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
  }

  // Round-6 finding R6-07: --allowed-origin/--health-url used to be
  // caller-supplied, cross-checked only against each other -- proving
  // nothing about whether --db-url actually belongs to that same
  // application. --target now selects a fixed entry from the committed
  // rollout-environments.json manifest; the origin, health URL, expected
  // `environment` value, AND the Supabase project ref --db-url must
  // resolve to are all bound together there, reviewed and diffable like
  // any other change, not assembled at the command line.
  if (!raw["target"]) {
    throw new Error(
      `Missing required argument: --target. Known targets: ${Object.keys(environments).join(", ") || "(none configured)"}.`,
    );
  }
  const env = environments[raw["target"]];
  if (!env) {
    throw new Error(
      `--target "${raw["target"]}" is not defined in rollout-environments.json. Known targets: ${Object.keys(environments).join(", ") || "(none configured)"}.`,
    );
  }
  args.target = raw["target"];
  args.allowedOrigin = env.allowedOrigin;
  args.healthUrl = env.healthUrl;
  args.supabaseProjectRef = env.supabaseProjectRef;
  args.environment = env.environment;

  // Reject a --db-url/--target mismatch before phase 0 runs, not after a
  // migration has already been applied against the wrong database.
  const dbUrlProjectRef = projectRefFromDbUrl(args.dbUrl);
  if (dbUrlProjectRef !== args.supabaseProjectRef) {
    throw new Error(
      `--db-url resolves to project ref "${dbUrlProjectRef ?? "unparseable"}", but --target "${args.target}" expects ` +
        `"${args.supabaseProjectRef}" (rollout-environments.json). Refusing to run a rollout against a database that ` +
        "doesn't match the target's own manifest entry.",
    );
  }

  return args;
}

/**
 * General-purpose, strict plan validation: every named migration must
 * exist as a real file AND currently be pending, and every currently
 * pending migration must be named by one of the two lists. Retained
 * exactly as-is (still exported, still covers a fresh, from-scratch
 * rollout) -- `prepare`/`finalize` below use their own, phase-appropriate
 * variants instead, tolerant of a migration this SAME phase already
 * applied on an earlier, interrupted run (see validatePreparePlan/
 * validateFinalizePlan for why "already done" must not be indistinguishable
 * from "never was going to happen").
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

/**
 * Prepare-phase validation. Unlike validateMigrationPlan above, this
 * tolerates an --expand migration that's already been applied -- required
 * for `prepare` to be safely re-runnable after a prior run of ITSELF
 * fully or partially succeeded (a real interruption scenario: a network
 * drop mid-`db push`, applying migration 2 of 4). An --enforce migration
 * NOT being pending here is a different matter and stays a hard failure:
 * prepare's own `db push` explicitly stages enforce migrations out of the
 * directory before running, so one becoming non-pending during prepare
 * can only mean it was applied out of band -- most likely `finalize`
 * already ran, in which case prepare has nothing left to usefully do, but
 * that's worth surfacing, not silently absorbing. Every currently pending
 * migration must still be named by one of the two lists, unconditionally
 * -- that property doesn't get weaker just because this phase tolerates
 * partial completion of its own prior work.
 */
export function validatePreparePlan(pending, expandList, enforceList, allFiles) {
  const allFilesSet = new Set(allFiles);
  const pendingSet = new Set(pending);
  const plannedSet = new Set([...expandList, ...enforceList]);

  for (const name of expandList) {
    if (!allFilesSet.has(name)) {
      throw new Error(`--expand names "${name}", which does not exist in supabase/migrations/.`);
    }
  }
  for (const name of enforceList) {
    if (!allFilesSet.has(name)) {
      throw new Error(`--enforce names "${name}", which does not exist in supabase/migrations/.`);
    }
    if (!pendingSet.has(name)) {
      throw new Error(
        `--enforce names "${name}", but it is not currently pending against this database. It should never become ` +
          "applied during the prepare phase (enforce migrations are staged out of supabase/migrations/ before this " +
          "phase's own `db push` runs) -- if `finalize` has already run, prepare has nothing left to do.",
      );
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

/**
 * Finalize-phase validation: the mirror case of validatePreparePlan.
 * Tolerates --enforce migrations that are already fully (or partially)
 * applied -- required for `finalize` to be safely re-runnable after a
 * prior run of ITSELF succeeded or was interrupted mid-way. What it will
 * never tolerate is anything ELSE pending that isn't in --enforce: an
 * expand migration that never finished (prepare didn't run, ran against a
 * different database, or was itself interrupted before completing) is
 * exactly the condition the task requires finalize to refuse outright,
 * not attempt to apply alongside the reviewed enforce set.
 */
export function validateFinalizePlan(pending, enforceList, allFiles) {
  const allFilesSet = new Set(allFiles);
  const pendingSet = new Set(pending);
  const enforceSet = new Set(enforceList);

  for (const name of enforceList) {
    if (!allFilesSet.has(name)) {
      throw new Error(`--enforce names "${name}", which does not exist in supabase/migrations/.`);
    }
  }

  const unexpectedlyPending = pending.filter((name) => !enforceSet.has(name));
  if (unexpectedlyPending.length > 0) {
    throw new Error(
      `${unexpectedlyPending.length} migration(s) are pending that are not in --enforce: ${unexpectedlyPending.join(", ")}. ` +
        "Refusing to continue -- this most likely means an expand migration never finished (the prepare phase " +
        "didn't run, ran against a different database, or was itself interrupted before completing). Run `prepare` " +
        "again first and confirm it succeeds before retrying finalize.",
    );
  }

  return { remaining: enforceList.filter((name) => pendingSet.has(name)) };
}

/**
 * Round-7 finding R7-02 (HIGH): execFileSync's own thrown Error embeds the
 * FULL command line in `.message` ("Command failed: <cmd> <args...>",
 * confirmed by direct reproduction) on any non-zero exit, plus separate
 * `.stdout`/`.stderr` properties -- none of which sh()'s own redacted
 * console.log line ever protected; that only covered the happy-path log
 * line, never a thrown failure. --db-url carries a real password this
 * script doesn't control the contents of, and the top-level catch in
 * main() prints exactly this message unchanged -- disclosing it in
 * plaintext to whatever captures this script's stderr (a CI log, a
 * terminal transcript, an incident channel).
 *
 * Fixed generically, not by stripping only the one --db-url this call
 * happens to be using: CONNECTION_STRING_CREDENTIALS matches the userinfo
 * portion of any postgres(ql):// URL appearing anywhere in the text (the
 * CLI's own output could echo a differently-formatted but still-sensitive
 * connection string, e.g. after resolving a pooler alias), and
 * credentialSecretsFromArgs additionally extracts this specific call's own
 * username/password -- both as they appear literally in the URL and
 * percent-decoded -- for a second, targeted substring pass, in case either
 * leaks outside a full URL context (e.g. a bare password echoed by a
 * misconfigured error message).
 */
const CONNECTION_STRING_CREDENTIALS = /(postgres(?:ql)?:\/\/)([^@/\s]*)@/gi;

export function redactConnectionStrings(text, extraSecrets = []) {
  if (typeof text !== "string" || !text) return text;
  let result = text.replace(CONNECTION_STRING_CREDENTIALS, "$1[redacted]@");
  for (const secret of extraSecrets) {
    if (secret) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}

export function credentialSecretsFromArgs(args) {
  const secrets = [];
  for (const arg of args) {
    if (typeof arg !== "string" || !arg.includes("://")) continue;
    let url;
    try {
      url = new URL(arg);
    } catch {
      continue;
    }
    for (const raw of [url.username, url.password]) {
      if (!raw) continue;
      secrets.push(raw);
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded !== raw) secrets.push(decoded);
      } catch {
        // Not percent-encoded, or malformed -- the raw form above still covers it.
      }
    }
  }
  return secrets;
}

function sanitizeSubprocessError(err, args) {
  const secrets = credentialSecretsFromArgs(args);
  const toSafeString = (value) => {
    if (typeof value === "string") return redactConnectionStrings(value, secrets);
    if (value && typeof value.toString === "function") return redactConnectionStrings(value.toString(), secrets);
    return value;
  };
  const sanitized = new Error(toSafeString(err instanceof Error ? err.message : String(err)));
  sanitized.status = err?.status;
  sanitized.signal = err?.signal;
  sanitized.stdout = toSafeString(err?.stdout);
  sanitized.stderr = toSafeString(err?.stderr);
  // Deliberately does NOT copy err.output or any other property forward --
  // a fresh Error with only these explicitly-sanitized fields means there
  // is no un-sanitized property left for a future change to accidentally
  // log or serialize.
  return sanitized;
}

export function sh(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.filter((a) => !a.includes("://")).join(" ")} [connection string redacted from log]`);
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", ...opts });
  } catch (err) {
    throw sanitizeSubprocessError(err, args);
  }
}

function listMigrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

export function getPendingMigrations(dbUrl) {
  const raw = sh(NPX, ["supabase", "migration", "list", "--db-url", dbUrl, "--output-format", "json"]);
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    // Found during this round's own independent self-review: sh() only
    // sanitizes a THROWN (non-zero-exit) failure -- this is a success-exit
    // path (getPendingMigrations calls sh(), which returned normally) that
    // previously embedded the raw, un-redacted stdout directly into a
    // thrown error message. If a future `supabase` CLI version ever mixes
    // a warning/banner line containing --db-url into its stdout on an
    // otherwise-successful exit, that credential would reach whatever
    // catches this error (main()'s console.error) completely unsanitized,
    // bypassing sanitizeSubprocessError entirely since no subprocess
    // actually failed here. Redact defensively the same way a failure
    // would be, even though this path isn't itself a credential source.
    throw new Error(
      `Expected JSON from 'supabase migration list --output-format json', got: ${redactConnectionStrings(raw, credentialSecretsFromArgs(["--db-url", dbUrl]))}`,
    );
  }
  const parsed = JSON.parse(raw.slice(jsonStart));
  const knownFiles = listMigrationFiles();
  return parsed.migrations
    .filter((m) => !m.remote || m.remote.trim() === "")
    .map((m) => {
      // Round-5 R5-04: this used to be `.find(...) ` piped straight into
      // `.filter(Boolean)` -- an unrecognized local version silently
      // vanished from the result instead of being surfaced, so it could
      // disappear from both "what will phase 1 apply" and "did the final
      // check actually cover everything."
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

export async function pollHealth(healthUrl, expectedSha, expectedEnvironment, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastBody = null;
  while (Date.now() < deadline) {
    try {
      // Round-7 finding R7-04: fetch follows redirects by default -- a
      // configured healthUrl could be redirected (by a compromised or
      // merely misconfigured intermediary) to a different host entirely,
      // which could then return a spoofed `ok`+matching-commitSha+
      // matching-environment response and incorrectly authorize the
      // enforce phase. allowedOrigin exists specifically to name the one
      // origin this script trusts (validated against healthUrl already, in
      // loadEnvironments) -- redirect: "error" means ANY redirect response
      // (same-origin or not) is treated as a failure, the same as any
      // other unreachable/invalid response, rather than silently followed
      // wherever it points.
      const res = await fetch(healthUrl, { cache: "no-store", redirect: "error" });
      const body = await res.json();
      lastBody = body;
      // Round-5 R5-05: also requires a matching environment, not just
      // ok+commitSha -- a health response is otherwise only as
      // trustworthy as whatever server answered --health-url, and ok:true
      // with a matching SHA is a low bar for something about to authorize
      // writes to a real production database. --health-url itself is now
      // bound to --target via rollout-environments.json (round-6 R6-07),
      // not a caller-supplied argument.
      if (res.ok && body.ok && body.commitSha === expectedSha && body.environment === expectedEnvironment) {
        return body;
      }
      // Found during an independent review: /api/health's own 503 response
      // already carries a specific, actionable `error` field (e.g. "APP_ENV
      // is not set") -- previously only ok/commitSha/environment were
      // logged, so an operator whose deployment was healthy in every way
      // EXCEPT a missing APP_ENV saw the exact same "not yet" line as a
      // deployment that simply hadn't finished building yet, with no hint
      // that APP_ENV specifically was the blocker. Surfacing it here is the
      // difference between "wait longer" and "go set this one thing."
      console.log(
        `  not yet -- commitSha=${body.commitSha} ok=${body.ok} environment=${body.environment} (want ${expectedSha}, ${expectedEnvironment})` +
          (body.error ? `\n    /api/health says: ${body.error}` : ""),
      );
    } catch (err) {
      console.log(`  health check request failed: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for ${healthUrl} to report commit ${expectedSha} in ${expectedEnvironment}. ` +
      `Last response: ${JSON.stringify(lastBody)}.` +
      (lastBody?.error ? ` /api/health's own last reported reason: ${lastBody.error}` : "") +
      " This does not necessarily mean the deployment is broken -- check the Vercel Deployments dashboard directly, " +
      "and confirm APP_ENV is set in Vercel for this environment (DEPLOYMENT.md § 3) if /api/health has never once " +
      "reported ok:true. Refusing to apply the enforce migrations against unverified application code.",
  );
}

/**
 * `prepare` phase: applies ONLY the expand migrations. Safe to run before
 * any merge or deploy -- expand migrations are additive/backward-
 * compatible by construction, so applying them ahead of new application
 * code never breaks the currently-live old code. Needs no commit SHA and
 * does not touch /api/health at all.
 */
export function runPrepare(args) {
  console.log(`Target: "${args.target}" (${args.environment}) -- ${args.allowedOrigin}, project ref ${args.supabaseProjectRef}`);
  console.log("=== Prepare: validate the plan against the database ===");
  const pendingAtStart = getPendingMigrations(args.dbUrl);
  console.log(`Pending: ${pendingAtStart.length} total (${args.expand.length} expand, ${args.enforce.length} enforce planned)`);
  validatePreparePlan(pendingAtStart, args.expand, args.enforce, listMigrationFiles());
  console.log("Plan matches the database: every pending migration is accounted for.");

  if (args.expand.length === 0) {
    console.log("No expand migrations to apply -- nothing for prepare to do.");
  } else {
    const stagingDir = mkdtempSync(path.join(tmpdir(), "rollout-enforce-staging-"));
    const moved = [];
    try {
      for (const file of args.enforce) {
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
      const pushArgs = ["supabase", "db", "push", "--db-url", args.dbUrl, "--include-all"];
      if (args.dryRun) pushArgs.push("--dry-run");
      else pushArgs.push("--yes");
      sh(NPX, pushArgs);
    } finally {
      for (const file of moved) {
        renameSync(path.join(stagingDir, file), path.join(migrationsDir, file));
      }
      rmSync(stagingDir, { recursive: true, force: true });
      console.log(`Restored ${moved.length} staged migration file(s) to supabase/migrations/.`);
    }
  }

  if (args.dryRun) {
    console.log("\n--dry-run: nothing was actually applied.");
    return;
  }

  // Verify the exact expected residual: everything named in --expand is
  // now applied (or already was, on a resumed run), and nothing else
  // moved -- pending should be exactly --enforce (or a subset of it, on a
  // resumed run partway through prepare itself), never more.
  const stillPending = new Set(getPendingMigrations(args.dbUrl));
  const enforceSet = new Set(args.enforce);
  const unexpectedlyApplied = args.enforce.filter((f) => !stillPending.has(f));
  const unexpectedlyPending = [...stillPending].filter((f) => !enforceSet.has(f));
  if (unexpectedlyApplied.length > 0) {
    throw new Error(`Prepare unexpectedly applied enforce migration(s): ${unexpectedlyApplied.join(", ")}.`);
  }
  if (unexpectedlyPending.length > 0) {
    throw new Error(
      `After prepare, ${unexpectedlyPending.length} migration(s) are pending that aren't in --enforce: ` +
        `${unexpectedlyPending.join(", ")}. This should not be possible -- investigate before running finalize.`,
    );
  }
  console.log(
    `\nPrepare complete. Exactly the --enforce set remains pending: ${args.enforce.join(", ") || "(none)"}. ` +
      "Merge/deploy now, then run `finalize` with the ACTUAL resulting commit SHA.",
  );
}

/**
 * `finalize` phase: waits for the actual, already-merged commit to be
 * live, drains, re-checks, and applies ONLY the enforce migrations.
 * Refuses outright if anything other than --enforce is still pending.
 */
export async function runFinalize(args) {
  console.log(`Target: "${args.target}" (${args.environment}) -- ${args.allowedOrigin}, project ref ${args.supabaseProjectRef}`);
  console.log("=== Finalize, step 1: confirm only --enforce is pending ===");
  const pendingAtStart = getPendingMigrations(args.dbUrl);
  const { remaining } = validateFinalizePlan(pendingAtStart, args.enforce, listMigrationFiles());
  const nothingToApply = remaining.length === 0;

  // Found during an independent review: this used to return here
  // immediately when nothing was pending, without ever polling health --
  // so an operator who ran finalize with the WRONG --expected-sha (or
  // against a database where the enforce migrations became applied some
  // other way -- an out-of-band change, or a genuinely completed prior
  // run under a DIFFERENT expected SHA) still saw finalize report success,
  // with nothing ever having confirmed the live deployment actually
  // matches what was asked for THIS time. An empty "remaining" set proves
  // the database side is done; it proves nothing about the application
  // side, which is the other half of what finalize exists to confirm. So
  // the health poll below (step 2) now always runs -- only the
  // migration-application-specific steps (drain, the pre-apply smoke
  // check, and the push itself) are skipped when there's nothing to apply.
  if (nothingToApply) {
    console.log(
      "Nothing pending at all -- enforce migrations already applied on a prior run. Still verifying the live deployment before declaring success.",
    );
  } else {
    console.log(`Confirmed: ${remaining.length} of ${args.enforce.length} --enforce migration(s) remain pending: ${remaining.join(", ")}.`);
  }

  if (args.dryRun) {
    if (nothingToApply) {
      console.log("\n--dry-run: nothing pending, nothing to preview.");
      return;
    }
    console.log("\n--dry-run: previewing the enforce push without waiting for health or applying anything.");
    sh(NPX, ["supabase", "db", "push", "--db-url", args.dbUrl, "--include-all", "--dry-run"]);
    return;
  }

  console.log(`\n=== Finalize, step 2: wait for the expected commit to be live in ${args.environment} ===`);
  console.log(`Polling ${args.healthUrl} for commitSha=${args.expectedSha} (timeout ${args.deployTimeoutSeconds}s)...`);
  console.log("(APP_ENV must already be set in Vercel for this environment -- DEPLOYMENT.md § 3 -- or this can never succeed.)");
  await pollHealth(args.healthUrl, args.expectedSha, args.environment, args.deployTimeoutSeconds);
  console.log(`Confirmed: ${args.environment} is serving the expected commit.`);

  if (nothingToApply) {
    console.log(
      "\nNothing left to apply, and the live deployment genuinely matches --expected-sha/--enforce -- finalize was already completed on a prior run. Nothing further to do.",
    );
    return;
  }

  console.log(`\n=== Finalize, step 3: drain window (${args.drainSeconds}s) ===`);
  await new Promise((resolve) => setTimeout(resolve, args.drainSeconds * 1000));

  console.log("\n=== Finalize, step 4: compatibility smoke check ===");
  const health = await pollHealth(args.healthUrl, args.expectedSha, args.environment, 30);
  console.log(`Smoke check passed: ${JSON.stringify(health)}`);

  console.log("\n=== Finalize, step 5: apply enforce migrations ===");
  console.log(`Applying ${remaining.length} migration(s): ${remaining.join(", ")}`);
  sh(NPX, ["supabase", "db", "push", "--db-url", args.dbUrl, "--include-all", "--yes"]);

  console.log("\n=== Finalize, step 6: final verification ===");
  const stillPending = getPendingMigrations(args.dbUrl);
  if (stillPending.length > 0) {
    throw new Error(`Finalize finished but migrations are still pending: ${stillPending.join(", ")}`);
  }
  console.log("All migrations applied. Rollout complete.");
}

async function main() {
  const environments = loadEnvironments(readFileSync(environmentsPath, "utf-8"));
  const args = parseArgs(process.argv.slice(2), environments);

  if (args.command === "prepare") {
    runPrepare(args);
  } else {
    await runFinalize(args);
  }
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
