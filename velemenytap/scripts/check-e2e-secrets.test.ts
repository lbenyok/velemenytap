import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkE2eSecrets } from "./check-e2e-secrets.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./check-e2e-secrets.mjs", import.meta.url));

/**
 * Runs the script as a real subprocess, the way the CI workflow actually
 * invokes it -- `checkE2eSecrets()` alone can't catch a bug in the
 * script's own CLI entry-point detection (`import.meta.url ===
 * pathToFileURL(process.argv[1]).href`), which is exactly the kind of bug
 * that shipped here: a naive `file://${process.argv[1]}` comparison never
 * matched when argv[1] is relative (the normal case for `node
 * scripts/foo.mjs`), so `main()` silently never ran and the script always
 * exited 0 regardless of scenario -- caught only by actually running it,
 * not by unit-testing the pure function in isolation.
 */
function runScript(env: Record<string, string>): { status: number; stdout: string } {
  const baseEnv = { ...process.env };
  for (const key of [
    "SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_DB_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "PR_HEAD_REPO",
    "GITHUB_OUTPUT",
  ]) {
    delete baseEnv[key];
  }
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH], {
      env: { ...baseEnv, ...env },
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { status: e.status, stdout: e.stdout };
  }
}

const ALL_SECRETS = {
  SUPABASE_SECRET_KEY: "sk",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk",
  SUPABASE_DB_URL: "postgresql://...",
};

describe("checkE2eSecrets", () => {
  it("is configured when all four secrets are present", () => {
    const result = checkE2eSecrets({ ...ALL_SECRETS, GITHUB_EVENT_NAME: "push" });
    expect(result.configured).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("is not configured when any one secret is missing, and lists exactly which", () => {
    const rest = Object.fromEntries(Object.entries(ALL_SECRETS).filter(([key]) => key !== "SUPABASE_DB_URL"));
    const result = checkE2eSecrets({ ...rest, GITHUB_EVENT_NAME: "push" });
    expect(result.configured).toBe(false);
    expect(result.missing).toEqual(["SUPABASE_DB_URL"]);
  });

  it("is not configured when every secret is missing", () => {
    const result = checkE2eSecrets({ GITHUB_EVENT_NAME: "push" });
    expect(result.configured).toBe(false);
    expect(result.missing).toEqual([
      "SUPABASE_SECRET_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_DB_URL",
    ]);
  });

  it("is not a fork PR on a push to master, even with secrets missing", () => {
    const result = checkE2eSecrets({ GITHUB_EVENT_NAME: "push" });
    expect(result.isForkPr).toBe(false);
  });

  it("is not a fork PR for a pull_request from the same repository", () => {
    const result = checkE2eSecrets({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "lbenyok/velemenytap",
      PR_HEAD_REPO: "lbenyok/velemenytap",
    });
    expect(result.isForkPr).toBe(false);
  });

  it("is a fork PR when the pull_request head repo differs from the base repository", () => {
    const result = checkE2eSecrets({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "lbenyok/velemenytap",
      PR_HEAD_REPO: "someone-else/velemenytap",
    });
    expect(result.isForkPr).toBe(true);
  });

  it("is not a fork PR when the head repo info is unavailable (never silently trust an absence as 'fork')", () => {
    const result = checkE2eSecrets({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "lbenyok/velemenytap" });
    expect(result.isForkPr).toBe(false);
  });

  it("a fully configured fork PR is still just 'configured' -- isForkPr only matters when secrets are missing", () => {
    const result = checkE2eSecrets({
      ...ALL_SECRETS,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "lbenyok/velemenytap",
      PR_HEAD_REPO: "someone-else/velemenytap",
    });
    expect(result.configured).toBe(true);
  });
});

describe("check-e2e-secrets.mjs CLI (real subprocess, not just the pure function)", () => {
  it("exits 1 on a trusted ref (push) with secrets missing", () => {
    const { status, stdout } = runScript({ GITHUB_EVENT_NAME: "push" });
    expect(status).toBe(1);
    expect(stdout).toContain("configured=false");
    expect(stdout).toContain("::error::");
  });

  it("exits 1 on a same-repo pull_request with secrets missing", () => {
    const { status, stdout } = runScript({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "lbenyok/velemenytap",
      PR_HEAD_REPO: "lbenyok/velemenytap",
    });
    expect(status).toBe(1);
    expect(stdout).toContain("::error::");
  });

  it("exits 0 (skip, not fail) on a fork pull_request with secrets missing", () => {
    const { status, stdout } = runScript({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "lbenyok/velemenytap",
      PR_HEAD_REPO: "someone-else/velemenytap",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("configured=false");
    expect(stdout).toContain("::warning::");
  });

  it("exits 0 when all secrets are present", () => {
    const { status, stdout } = runScript({ ...ALL_SECRETS, GITHUB_EVENT_NAME: "push" });
    expect(status).toBe(0);
    expect(stdout).toContain("configured=true");
  });
});
