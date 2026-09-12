import { test, expect } from "@playwright/test";

/**
 * `proxy.ts`'s PUBLIC_PATHS allowlist, tested from outside.
 *
 * Every route here is called by something that has no user session — CI, the
 * rollout script, Stripe, a GitHub Actions cron — and each has its own real
 * security boundary (a signature check, a bearer token, or nothing to protect
 * at all). If the middleware bounces one of them to `/login`, the caller does
 * not see an auth error: it sees a `307` with the body `Redirecting...`, which
 * is not an HTTP failure and parses as no JSON at all.
 *
 * That is not hypothetical. `/api/health` was added to production with CI's
 * `verify-production-deployment` job built on top of it (round-4 R4-01) and
 * was never added to PUBLIC_PATHS. Measured against the live site on
 * 2026-09-12: `307 → /login?next=%2Fapi%2Fhealth`. The job's `curl -fsS` has
 * no `-L`, so it reads `Redirecting...`, fails every `JSON.parse`, and polls
 * its full 300-second deadline before failing — a guard that exists because
 * deployments once silently stopped being created, and that could not itself
 * succeed. Nothing in the suite covered the middleware, only the route
 * handlers behind it, so nothing caught it.
 *
 * The negative control at the bottom is what stops "PUBLIC_PATHS = everything"
 * from satisfying this file.
 */

const PUBLICLY_REACHABLE = [
  {
    path: "/api/health",
    why: "CI's post-deploy verification and scripts/rollout.mjs both poll it with no session",
  },
  {
    path: "/api/webhooks/stripe",
    why: "Stripe's servers call it; its signature check is the real boundary",
  },
  {
    path: "/api/admin/reconcile-billing-sweep",
    why: "a GitHub Actions cron calls it; its bearer token is the real boundary",
  },
] as const;

for (const { path, why } of PUBLICLY_REACHABLE) {
  test(`${path} is reachable without a session (${why})`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });

    // The assertion is deliberately NOT "returns 200": two of these three
    // correctly refuse a GET on their own terms (they are POST-only, and
    // behind that a signature check and a bearer token). What must never
    // happen is the MIDDLEWARE answering for them with a redirect to the login
    // page, because a machine caller cannot tell that apart from a real
    // response -- which is exactly how /api/health failed silently.
    const location = response.headers()["location"] ?? "";
    const redirectedToLogin =
      response.status() >= 300 && response.status() < 400 && location.includes("/login");

    expect(
      redirectedToLogin,
      `${path} was bounced to ${location} by the middleware — ` +
        "it is missing from PUBLIC_PATHS in proxy.ts",
    ).toBe(false);
  });
}

test("/api/health answers CI's actual question, not just any 200", async ({ request }) => {
  const response = await request.get("/api/health", { maxRedirects: 0 });

  // What `verify-production-deployment` parses. A body it cannot parse is
  // indistinguishable, to that job, from a deployment that never happened.
  const body = await response.json();
  expect(body).toHaveProperty("ok");
  expect(body).toHaveProperty("commitSha");
  expect(body).toHaveProperty("environment");
});

test("a protected route still redirects to login — the control this file needs", async ({
  request,
}) => {
  const response = await request.get("/dashboard", { maxRedirects: 0 });

  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/login");
});
