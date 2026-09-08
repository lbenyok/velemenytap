#!/usr/bin/env node
// Round-5 finding R5-01: the e2e job's required-secrets check used to only
// ever emit a warning and skip -- on a trusted ref (a push to master, or a
// pull_request from a branch within this same repo, both of which DO
// receive repository secrets from GitHub Actions), a missing secret must
// fail CI outright. Silently skipping the RPC privilege matrix, RLS tests,
// and migration-race tests must never look identical to a clean run.
//
// Fork pull requests are the one legitimate case where secrets are
// genuinely absent -- GitHub Actions never exposes repository secrets to a
// `pull_request` run whose head is a fork, by design (unlike
// `pull_request_target`, which this repo does not use). That case still
// skips gracefully, exactly as before.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_KEYS = [
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_DB_URL",
];

export function checkE2eSecrets(env) {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  const configured = missing.length === 0;
  const isForkPr =
    env.GITHUB_EVENT_NAME === "pull_request" &&
    !!env.PR_HEAD_REPO &&
    !!env.GITHUB_REPOSITORY &&
    env.PR_HEAD_REPO !== env.GITHUB_REPOSITORY;

  return { configured, missing, isForkPr };
}

function setOutput(name, value) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  const result = checkE2eSecrets(process.env);
  setOutput("configured", result.configured);

  if (result.configured) {
    return;
  }

  if (result.isForkPr) {
    console.log(
      `::warning::e2e secrets unavailable on a fork pull request (expected -- GitHub Actions never exposes repository secrets to a pull_request run from a fork). Missing: ${result.missing.join(", ")}. The e2e job will skip for this PR only.`,
    );
    return;
  }

  console.log(
    `::error::Required e2e secrets are missing on a trusted ref (${process.env.GITHUB_EVENT_NAME}, same-repo). Missing: ${result.missing.join(", ")}. Failing CI rather than silently skipping the RPC privilege matrix, RLS tests, and other database-dependent checks -- add these under Settings -> Secrets and variables -> Actions, pointed at the isolated test project.`,
  );
  process.exitCode = 1;
}

// A naive `file://${process.argv[1]}` comparison is broken whenever
// argv[1] is relative (the normal case for `node scripts/foo.mjs`) or
// contains characters needing percent-encoding in a URL (both true here)
// -- pathToFileURL() resolves and encodes it the same way import.meta.url
// is already formatted, so the two can actually be compared.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
