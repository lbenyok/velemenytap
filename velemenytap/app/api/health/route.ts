import { LATEST_MIGRATION, MIGRATION_COUNT } from "@/lib/build-info";

/**
 * Round-4 finding R4-01. Production had no way to prove which commit was
 * actually deployed -- the Vercel Git webhook had silently stopped firing
 * at some point before round 1, and nothing detected it: the Deployments
 * dashboard still showed a "Ready" build (just an old one), and there was
 * no automated check comparing what was *deployed* against what was
 * *pushed*.
 *
 * Round-6 finding R6-06 (this version). Round 5's fix (R5-05) computed
 * "is this a deployed environment" from BUILD_VERCEL_ENV, a build-time
 * snapshot of process.env.VERCEL_ENV, on the theory that Vercel's build
 * step always has VERCEL_ENV available regardless of the project's
 * "Automatically expose System Environment Variables" toggle. That theory
 * was wrong: per Vercel's own current documentation
 * (https://vercel.com/docs/environment-variables/system-environment-variables),
 * VERCEL_ENV is a System Environment Variable gated by that exact toggle
 * at BOTH build and runtime -- there is no build-time carve-out. A project
 * with the toggle disabled would have BUILD_VERCEL_ENV null too, and the
 * old logic fell through to `environment: "development", ok: true` --
 * silently hiding precisely the misconfiguration this endpoint exists to
 * catch. See DECISIONS.md for the full correction.
 *
 * Fixed by never trusting ANY Vercel-managed System Environment Variable
 * for the fail-closed decision. `APP_ENV` is a plain, ordinary application
 * environment variable the repository owner sets directly in Vercel
 * Project Settings -> Environment Variables, scoped per Vercel environment
 * (Production: APP_ENV=production, Preview: APP_ENV=preview) -- see
 * DEPLOYMENT.md § 3. Ordinary project environment variables are NOT
 * System Environment Variables and are never gated by that toggle, so
 * APP_ENV cannot be silently withheld by the same misconfiguration this
 * check exists to detect.
 *
 * "Local development" is decided from NODE_ENV, not from any Vercel
 * variable either -- `next dev` always sets NODE_ENV=development. This is
 * the explicit, testable local-development condition the finding asks
 * for: it does not depend on being told it's running locally by a value
 * only a genuine deployment would ever set.
 *
 * In a production-mode build (NODE_ENV=production) that cannot establish
 * APP_ENV as "production" or "preview", this fails closed (503,
 * ok:false) -- it never infers "development" merely because Vercel's own
 * metadata is missing, which is exactly the inference that let a broken
 * deployment misreport as healthy before.
 *
 * Round-7 finding R7-07: this used to treat anything OTHER than exactly
 * "production" as local dev (`NODE_ENV !== "production"`) -- fail-OPEN,
 * since an unset, malformed, or unexpected value like "test"/"staging"
 * also fell through to "development, ok: true" rather than to the strict
 * checks above. Flipped to fail-CLOSED: only the one value `next dev`
 * itself actually sets (`NODE_ENV === "development"`) is treated as local
 * development; every other value -- missing, malformed, "test", or
 * anything else -- now requires APP_ENV/commitSha to be established the
 * same as a genuine production-mode build would.
 */
export async function GET() {
  const isLocalDev = process.env.NODE_ENV === "development";
  const appEnv = process.env.APP_ENV ?? null;
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const commitRef = process.env.VERCEL_GIT_COMMIT_REF ?? null;

  const knownAppEnv = appEnv === "production" || appEnv === "preview";
  const cannotEstablishIdentity = !isLocalDev && !knownAppEnv;
  const missingCommitSha = !isLocalDev && knownAppEnv && !commitSha;
  const ok = !cannotEstablishIdentity && !missingCommitSha;

  const environment = knownAppEnv ? appEnv : isLocalDev ? "development" : "unknown";

  let error: string | undefined;
  if (cannotEstablishIdentity) {
    error =
      `This is a production-mode build (NODE_ENV=production) but APP_ENV is ${
        appEnv === null ? "not set" : `set to the unrecognized value "${appEnv}"`
      } -- expected "production" or "preview". Set APP_ENV directly in Vercel Project ` +
      "Settings -> Environment Variables, scoped per environment (never a System Environment " +
      "Variable, so it can't be silently withheld by that toggle). See DEPLOYMENT.md § 3.";
  } else if (missingCommitSha) {
    error =
      `APP_ENV reports "${appEnv}" but VERCEL_GIT_COMMIT_SHA is not visible at runtime -- either ` +
      "this deployment did not go through Vercel's Git integration, or the project's " +
      "'Automatically expose System Environment Variables' setting is disabled. See DEPLOYMENT.md.";
  }

  const body = {
    ok,
    environment,
    commitSha,
    commitRef,
    latestMigration: LATEST_MIGRATION,
    migrationCount: MIGRATION_COUNT,
    ...(error ? { error } : {}),
  };

  return Response.json(body, { status: ok ? 200 : 503 });
}
