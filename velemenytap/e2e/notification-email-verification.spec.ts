import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
  userClient,
  type SeededOrgMember,
} from "./support/seed";
import { connectToTestDb } from "./support/db-connection";
import { signInViaUi } from "./support/ui";

/**
 * Round-3 finding R3-03. An organization's notification_email used to be
 * written directly, with no proof the org actually controlled the
 * address -- a real spam-relay risk once combined with round-2's
 * budget-limited (but still real) email sending capability.
 *
 * Fixed with a genuine confirmation flow: reserve_notification_email_change()
 * validates and rate-limits, then reserves a pending address; the actual
 * confirmation token is minted separately (round-6 R6-01, see below) and
 * emailed as a link; confirm_notification_email_change() promotes the
 * pending address to the active notification_email only when called with a
 * token whose hash matches a non-expired pending request.
 *
 * Round-6 finding R6-01 (HIGH): this RPC (renamed reserve_notification_
 * email_change during a second independent review -- see supabase/
 * migrations/20260905193325's header comment) used
 * to return the raw token directly to its `authenticated` caller -- so any
 * org member could call the RPC directly (bypassing the settings Server
 * Action and Resend entirely) and read a live token out of the response,
 * confirming an arbitrary address without ever proving control of its
 * inbox. Fixed by splitting the token out into a separate function,
 * issue_notification_email_change_token(), granted to `service_role`
 * ONLY -- reachable exclusively from trusted server code via the admin
 * client. reserve_notification_email_change() now returns only a log_id.
 *
 * Round-6 finding R6-04 (MEDIUM): the cooldown/budget used to be plain
 * caller-suppliable parameters (p_cooldown_minutes/p_org_hourly_budget)
 * with defaults -- an authenticated caller could simply override them to
 * disable its own rate limit. Both are now read from a per-organization
 * config table (private.notification_email_change_config, service_role
 * only) instead of accepted as RPC arguments at all. finalize_notification_
 * email_change_send() is also service_role-only now, not authenticated --
 * a client can no longer report its own reservation delivered/failed.
 */

let member: SeededOrgMember;
let dbClient: Client | null;

test.beforeAll(async () => {
  dbClient = await connectToTestDb();
});

test.afterAll(async () => {
  await dbClient?.end();
});

test.beforeEach(async () => {
  member = await seedOrgWithMember("notif-email-verify");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

/** Test-only helper: overrides this org's cooldown/budget so a test can
 * exercise the boundary quickly, without waiting real wall-clock time and
 * without racing any other concurrently-running test's own organization
 * (round-6 R6-04 -- see the migration's own comment on why this is
 * per-organization, not a shared global). Needs the direct Postgres
 * connection (private.notification_email_change_config isn't exposed to
 * PostgREST); callers must skip when dbClient is unavailable. */
async function setRateLimitConfig(orgId: number, cooldownMinutes: number, orgHourlyBudget: number) {
  await dbClient!.query(
    `insert into private.notification_email_change_config (organization_id, cooldown_minutes, org_hourly_budget)
     values ($1, $2, $3)
     on conflict (organization_id) do update set cooldown_minutes = excluded.cooldown_minutes, org_hourly_budget = excluded.org_hourly_budget`,
    [orgId, cooldownMinutes, orgHourlyBudget],
  );
}

/** Simulates what the real settings Server Action does server-side: calls
 * the authenticated RPC to reserve a request, then the service_role-only
 * RPC to mint the actual token -- since tests need a real, usable token to
 * exercise confirm_notification_email_change() with. */
async function requestAndIssueToken(
  client: Awaited<ReturnType<typeof userClient>>,
  orgId: number,
  email: string,
  expiresInMinutes?: number,
) {
  const { data: logId, error: requestError } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: orgId,
    p_email: email,
  });
  if (requestError || logId === null) return { logId: null, token: null, requestError };

  const admin = adminClient();
  const { data: token, error: tokenError } = await admin.rpc("issue_notification_email_change_token", {
    p_log_id: logId,
    ...(expiresInMinutes !== undefined ? { p_expires_in_minutes: expiresInMinutes } : {}),
  });
  return { logId, token: token ?? null, requestError: tokenError };
}

test("R3-03: requesting a new address sets it as pending, not active", async () => {
  const client = await userClient(member.email, member.password);
  const { data: logId, error } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
  expect(error).toBeNull();
  expect(typeof logId).toBe("number");

  const admin = adminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("notification_email, notification_email_pending")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBeNull();
  expect(org?.notification_email_pending).toBe("candidate@example.com");
});

test("R6-01: reserve_notification_email_change does not return the token -- it must be issued separately", async () => {
  // This is the direct regression test for the vulnerability: the raw
  // response from the authenticated-callable RPC must never contain
  // anything that looks like the 64-hex-character token
  // issue_notification_email_change_token() would otherwise mint.
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
  expect(error).toBeNull();
  expect(typeof data).toBe("number");
  expect(JSON.stringify(data)).not.toMatch(/^[0-9a-f]{64}$/);
});

test("R6-01: an authenticated client cannot call issue_notification_email_change_token directly (service_role only)", async () => {
  const client = await userClient(member.email, member.password);
  const { data: logId } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
  expect(logId).not.toBeNull();

  const { data, error } = await client.rpc("issue_notification_email_change_token", { p_log_id: logId! });
  expect(data).toBeNull();
  expect(error?.message).toContain("permission denied for function");

  const anonClient = userClientAnon();
  const anonAttempt = await anonClient.rpc("issue_notification_email_change_token", { p_log_id: logId! });
  expect(anonAttempt.error?.message).toContain("permission denied for function");
});

test("R6-04: an authenticated client cannot override the cooldown/budget -- the parameters no longer exist on the RPC", async () => {
  // Round-7 finding R7-03's general principle applied here too: assert the
  // SPECIFIC expected failure (PostgREST's "no matching function overload"
  // class, PGRST202), not merely "some error occurred" -- a permission
  // error or an unrelated failure would pass an "any error" assertion just
  // as easily without actually proving there's no overload left to tune.
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
    p_cooldown_minutes: 0,
    p_org_hourly_budget: 999999,
  });
  expect(data).toBeNull();
  expect(error?.code).toBe("PGRST202");
  expect(error?.message).toContain("Could not find the function");
});

test("R6-01: the round-3 3-argument function no longer exists at all -- it was dropped, not merely grant-stripped", async () => {
  // History here: round-6 (R6-01/R6-03) planned to keep this function
  // defined with its grants revoked, as a rollout-compatibility bridge.
  // Round-7's own verification discovered that plan never actually
  // worked -- its third parameter's default made it ambiguous against the
  // new 2-argument function for PostgREST's own overload resolution,
  // breaking every real call regardless of grants (see DECISIONS.md).
  // Migration 20260906100000 drops it outright. Calling it now fails as
  // "function not found" (PGRST202), not "permission denied" -- asserting
  // the SPECIFIC class, not just "some error", per round-7 R7-03's general
  // principle that an unconstrained error assertion proves nothing about
  // which failure actually occurred.
  // Deliberately still calls the OLD name (request_notification_email_change,
  // 3 arguments) here, NOT the current reserve_notification_email_change --
  // this test exists specifically to prove the LEGACY round-3 function is
  // gone. Found during an independent adversarial review: an earlier draft
  // of this file had a blanket rename sweep that renamed this call site
  // too, which made the test pass vacuously -- reserve_notification_email_
  // change was NEVER a 3-argument function, so calling IT with 3 args
  // always returns PGRST202 regardless of whether the legacy function had
  // actually been dropped, silently defeating the entire point of this
  // test. `as never` bypasses the generated Database type, which no longer
  // lists this function at all (it's genuinely gone) -- that absence is
  // exactly what this test is proving, so a type error here would be
  // fighting the test's own purpose, not a real bug.
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("request_notification_email_change" as never, {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
    p_expires_in_minutes: 1440,
  } as never);
  expect(data).toBeNull();
  expect(error?.code).toBe("PGRST202");
});

test("R3-03: confirming with the correct token promotes the pending address to active", async () => {
  const client = await userClient(member.email, member.password);
  const { token } = await requestAndIssueToken(client, member.orgId, "candidate@example.com");
  expect(token).not.toBeNull();

  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: token!,
  });
  expect(error).toBeNull();
  expect(confirmedOrgId).toBe(member.orgId);

  const { data: org } = await admin
    .from("organizations")
    .select("notification_email, notification_email_pending, notification_email_pending_token_hash")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBe("candidate@example.com");
  expect(org?.notification_email_pending).toBeNull();
  expect(org?.notification_email_pending_token_hash).toBeNull();
});

test("R3-03: an unknown or already-used token confirms nothing", async () => {
  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: "not-a-real-token",
  });
  expect(error).toBeNull();
  expect(confirmedOrgId).toBeNull();
});

test("R3-03: an expired token is rejected, even though it's otherwise valid", async () => {
  const client = await userClient(member.email, member.password);
  // Already expired the instant it's issued -- exercises the expiry
  // boundary directly, without waiting a real 24 hours or writing to a
  // column the enforcement trigger blocks even the admin client from
  // touching directly.
  const { token } = await requestAndIssueToken(client, member.orgId, "candidate@example.com", -1);
  expect(token).not.toBeNull();

  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: token!,
  });
  expect(error).toBeNull();
  expect(confirmedOrgId).toBeNull();

  const { data: org } = await admin
    .from("organizations")
    .select("notification_email")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBeNull();
});

test("R3-03: requesting a second address overwrites the first pending request; the old token stops working", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  await setRateLimitConfig(member.orgId, 0, 5);

  const client = await userClient(member.email, member.password);
  const first = await requestAndIssueToken(client, member.orgId, "first@example.com");
  const second = await requestAndIssueToken(client, member.orgId, "second@example.com");
  expect(first.token).not.toBe(second.token);

  const admin = adminClient();

  const firstAttempt = await admin.rpc("confirm_notification_email_change", { p_token: first.token! });
  expect(firstAttempt.data).toBeNull();

  const secondAttempt = await admin.rpc("confirm_notification_email_change", { p_token: second.token! });
  expect(secondAttempt.data).toBe(member.orgId);

  const { data: org } = await admin
    .from("organizations")
    .select("notification_email")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBe("second@example.com");
});

/**
 * Round-6 finding R6-05 (MEDIUM): confirm_notification_email_change() used
 * to SELECT the organization by token hash, then separately UPDATE it by
 * id alone, with no re-check of the token -- a TOCTOU race. A concurrent
 * reserve_notification_email_change() call for the same org, landing
 * between those two statements, replaces the pending address/token before
 * the UPDATE runs, which then blindly promotes the NEW pending address
 * using the OLD token's authority. Fixed by collapsing both statements
 * into one atomic UPDATE whose WHERE clause re-checks the token hash,
 * expiry, and pending-address presence, using RETURNING to learn whether
 * it matched. This test reproduces the exact race: hold a valid token for
 * address A, replace the pending request with address B before
 * confirming, then confirm the OLD token and assert it does NOT promote B.
 */
test("R6-05: a token cannot be used to confirm a DIFFERENT pending address requested after it was issued", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  // Cooldown disabled -- otherwise the second request below would be
  // rejected outright (VT203) rather than actually replacing the pending
  // request, which would prove nothing about the race this test targets.
  await setRateLimitConfig(member.orgId, 0, 5);

  const client = await userClient(member.email, member.password);
  const { token: staleToken } = await requestAndIssueToken(client, member.orgId, "original@example.com");
  expect(staleToken).not.toBeNull();

  // Simulates the race: a second request for the SAME org replaces the
  // pending address/token hash before the first token is ever confirmed.
  const second = await requestAndIssueToken(client, member.orgId, "attacker-controlled@example.com");
  expect(second.token).not.toBeNull();

  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: staleToken!,
  });
  expect(error).toBeNull();
  // The stale token must confirm NOTHING -- not the new pending address.
  expect(confirmedOrgId).toBeNull();

  const { data: org } = await admin
    .from("organizations")
    .select("notification_email")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBeNull();
});

test("R3-03: clearing the notification email needs no confirmation and works even with a pending request outstanding", async () => {
  const client = await userClient(member.email, member.password);
  await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });

  const { error } = await client.rpc("clear_notification_email", { p_organization_id: member.orgId });
  expect(error).toBeNull();

  const admin = adminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("notification_email, notification_email_pending, notification_email_pending_token_hash")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBeNull();
  expect(org?.notification_email_pending).toBeNull();
  expect(org?.notification_email_pending_token_hash).toBeNull();
});

test("R3-03: a member of a DIFFERENT organization cannot request a change for this one", async () => {
  const other = await seedOrgWithMember("notif-email-verify-other");
  try {
    const otherClient = await userClient(other.email, other.password);
    const { error } = await otherClient.rpc("reserve_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "attacker@example.com",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("not a member");
  } finally {
    await cleanupOrgWithMember(other.userId, other.orgId);
  }
});

test("R3-03: anon and authenticated cannot call confirm_notification_email_change directly (it's service_role only)", async () => {
  const client = await userClient(member.email, member.password);
  const { token } = await requestAndIssueToken(client, member.orgId, "candidate@example.com");

  const anonClient = userClientAnon();
  const anonAttempt = await anonClient.rpc("confirm_notification_email_change", { p_token: token! });
  expect(anonAttempt.error?.message).toContain("permission denied for function");

  const authAttempt = await client.rpc("confirm_notification_email_change", { p_token: token! });
  expect(authAttempt.error?.message).toContain("permission denied for function");
});

test("R3-03: an authenticated session cannot bypass verification by writing the notification email fields directly", async () => {
  const client = await userClient(member.email, member.password);
  const { error } = await client
    .from("organizations")
    .update({ notification_email: "direct-write@example.com" })
    .eq("id", member.orgId);
  expect(error).not.toBeNull();
  expect(error?.message).toContain("notification email fields");
});

test("R3-03: the Settings page shows a pending-confirmation notice, and visiting the confirm link updates it", async ({
  page,
}) => {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL(/\/dashboard$/);

  // Requested directly through the RPCs, not the Settings form -- the form
  // submission also tries to send the confirmation email via Resend, which
  // is deliberately unconfigured in this test project (e2e/README.md), so
  // going through the RPCs isolates what this test actually cares about:
  // how the Settings page RENDERS a pending request and what visiting the
  // confirm link does, not whether email-sending itself is available.
  const client = await userClient(member.email, member.password);
  const { token } = await requestAndIssueToken(client, member.orgId, "candidate@example.com");
  expect(token).not.toBeNull();

  await page.goto("/dashboard/settings");
  await expect(page.getByText("Megerősítésre vár:")).toBeVisible();
  await expect(page.getByText("candidate@example.com")).toBeVisible();
  // The active field itself is still empty -- the pending address hasn't
  // become the real notification_email yet.
  await expect(page.getByLabel("Értesítési e-mail cím")).toHaveValue("");

  await page.goto(`/api/notification-email/confirm?token=${encodeURIComponent(token!)}`);
  await expect(page).toHaveURL(/notification_email=confirmed/);
  await expect(page.getByText("Az e-mail cím megerősítve.")).toBeVisible();
  await expect(page.getByLabel("Értesítési e-mail cím")).toHaveValue("candidate@example.com");
  await expect(page.getByText("Megerősítésre vár:")).toHaveCount(0);
});

/**
 * Round-5 finding R5-12: reserve_notification_email_change() had no
 * cooldown or budget at all -- an authenticated member could trigger
 * unbounded real Resend sends by repeatedly submitting candidate
 * addresses. Fixed with the same dual-control pattern already proven for
 * the negative-feedback alert. Round-6 R6-04 moved the tunable values out
 * of the RPC's own arguments into a per-organization config row (see
 * setRateLimitConfig above) -- these tests exercise the same boundaries as
 * before, just tuned through that config instead of RPC parameters.
 */
test("R5-12: a second request within the cooldown window is rejected", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const client = await userClient(member.email, member.password);
  const first = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "first@example.com",
  });
  expect(first.error).toBeNull();

  const second = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "second@example.com",
  });
  expect(second.error?.code).toBe("VT203");
});

test("R5-12: an organization-wide hourly budget caps total requests, proven under real concurrency", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const BUDGET = 1;
  // Cooldown disabled specifically to isolate the budget from it -- unlike
  // the per-CARD alert cooldown, this one is per-ORGANIZATION, so every
  // concurrent call here would otherwise collide with it first rather than
  // exercising the budget check at all.
  await setRateLimitConfig(member.orgId, 0, BUDGET);

  const client = await userClient(member.email, member.password);
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      client.rpc("reserve_notification_email_change", {
        p_organization_id: member.orgId,
        p_email: `candidate-${i}@example.com`,
      }),
    ),
  );

  const succeeded = results.filter((r) => r.error === null);
  const budgetExceeded = results.filter((r) => r.error?.code === "VT204");
  expect(succeeded).toHaveLength(BUDGET);
  expect(budgetExceeded).toHaveLength(5 - BUDGET);
});

/**
 * Found during this round's own independent adversarial self-review, not
 * one of R7-01 through R7-08 as originally listed -- but the identical bug
 * class as R7-05 (claim_negative_alert_send), in the very function R6-04
 * had already partially fixed for it. reserve_notification_email_change()
 * captures clock_timestamp() correctly for its cooldown/budget CHECKS, but
 * the row it inserts right after used to rely on reserved_at's column
 * DEFAULT (now(), frozen at this transaction's own start -- before it
 * waited on the advisory lock), not the same clock_timestamp() value.
 *
 * This test forces the exact skew that bug depended on: a second raw
 * connection holds the same advisory lock reserve_notification_email_change
 * itself acquires (hashtext('notification_email_change:' || orgId)) for a
 * fixed, known duration, so the RPC call's transaction is genuinely queued
 * behind it -- not a timing assumption about how fast the RPC happens to
 * run. Once the lock is released and the RPC returns, the resulting log
 * row's reserved_at must be close to the moment the lock was actually
 * released (when the RPC's own clock_timestamp() call could first run),
 * never close to the moment the RPC call was originally issued (its
 * now()-frozen transaction start, well before the lock was free).
 */
test("R7-05-class: reserved_at reflects when the reservation actually happened, not a now() frozen before the advisory-lock wait", async () => {
  const lockHolder = await connectToTestDb();
  test.skip(!dbClient || !lockHolder, "No direct Postgres connection available in this environment.");
  if (!dbClient || !lockHolder) return;

  const HOLD_MS = 1500;
  try {
    // A server-side timestamp taken BEFORE the RPC's own transaction even
    // starts -- what an unfixed now() (frozen at transaction start) would
    // have produced for reserved_at, since the RPC call is issued only
    // after this. Compared against reserved_at using ONLY server-side
    // clock_timestamp() readings throughout this test, never the test
    // runner's own Date.now() -- a remote hosted database's clock is not
    // guaranteed to agree with the local machine's, and an earlier version
        // of this test compared client wall-clock time against server
    // timestamps directly, which produced a spurious multi-second mismatch
    // from clock skew alone, not from the bug this test exists to catch.
    const before = await dbClient.query<{ now: string }>("select clock_timestamp() as now");
    const beforeMs = new Date(before.rows[0].now).getTime();

    await lockHolder.query("begin");
    await lockHolder.query("select pg_advisory_xact_lock(hashtext('notification_email_change:' || $1::text))", [
      member.orgId,
    ]);

    const client = await userClient(member.email, member.password);
    let rpcStillBlocked = true;
    const rpcPromise = client
      .rpc("reserve_notification_email_change", { p_organization_id: member.orgId, p_email: "skew-check@example.com" })
      .then((r) => {
        rpcStillBlocked = false;
        return r;
      });

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    // The RPC's own advisory-lock wait must still be blocking it while the
    // raw connection above holds the identical lock key -- confirming this
    // test actually forces the skew, not merely hoping the RPC happens to
    // be slow enough on its own.
    expect(rpcStillBlocked).toBe(true);

    await lockHolder.query("commit");
    const released = await dbClient.query<{ now: string }>("select clock_timestamp() as now");
    const releasedMs = new Date(released.rows[0].now).getTime();
    const { data: logId, error } = await rpcPromise;
    expect(error).toBeNull();
    expect(logId).not.toBeNull();

    const { rows } = await dbClient.query(
      "select reserved_at from private.notification_email_change_log where id = $1",
      [logId],
    );
    const reservedAtMs = new Date(rows[0].reserved_at).getTime();

    // Before the fix: reserved_at fell back to the reserved_at column's
    // now() default -- frozen at the RPC's own transaction start, which
    // happened before it ever waited on the lock -- landing close to
    // `beforeMs`, well over a second too early. After the fix: it must
    // land at or after the lock was actually released, when
    // clock_timestamp() first had the chance to run inside the function.
    expect(reservedAtMs).toBeGreaterThanOrEqual(releasedMs - 500); // small tolerance for statement-execution time
    expect(reservedAtMs).toBeGreaterThan(beforeMs + HOLD_MS / 2); // the actual regression check
    expect(reservedAtMs).toBeLessThan(releasedMs + 5000);
  } finally {
    await lockHolder.query("rollback").catch(() => {});
    await lockHolder.end();
  }
});

test("R5-12: a failed send does not permanently consume the budget it never actually used", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const BUDGET = 1;
  await setRateLimitConfig(member.orgId, 0, BUDGET);

  const client = await userClient(member.email, member.password);
  const attempt1 = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt1@example.com",
  });
  expect(attempt1.error).toBeNull();
  const logId1 = attempt1.data;

  // Report it as a FAILED send (Resend rejected it, network error, etc.)
  // -- finalize_notification_email_change_send marks the reservation
  // 'failed', which the budget query excludes. Called via the admin
  // client -- round-6 R6-04 made this service_role-only.
  const admin = adminClient();
  const finalize = await admin.rpc("finalize_notification_email_change_send", {
    p_log_id: logId1!,
    p_delivered: false,
  });
  expect(finalize.error).toBeNull();

  // A second attempt, same tiny budget -- must succeed, because the first
  // one's failure freed the budget slot it reserved but never delivered.
  const attempt2 = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt2@example.com",
  });
  expect(attempt2.error).toBeNull();
});

/**
 * Round-7 finding R7-06 (LOW): settings-actions.ts used to return
 * immediately if issue_notification_email_change_token failed, without
 * ever finalizing the reservation reserve_notification_email_change had
 * already created -- stranding it as 'reserved' (consuming its budget
 * slot until it ages out of the trailing-hour window on its own) for a
 * token that was never even minted, let alone sent. Fixed with a
 * try/catch/finally that always finalizes as failed on that path.
 *
 * Two things this test proves that weren't covered before: (1)
 * issue_notification_email_change_token genuinely raises VT205 for a
 * reservation that isn't 'reserved' any more -- reproduced directly by
 * finalizing a reservation first, then attempting to issue a token for
 * it, its own real precondition check, not a contrived stand-in. (2) The
 * settings-actions.ts fix's actual dependency -- that finalizing an
 * issuance-failure path as `p_delivered: false` frees the budget slot the
 * same way a post-issuance send failure already does (the test directly
 * above) -- so repeated issuance failures can never consume all of an
 * organization's hourly request capacity.
 */
test("R7-06: issue_notification_email_change_token fails (VT205) for an already-resolved reservation, and finalizing that failure frees its budget slot", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const BUDGET = 2;
  await setRateLimitConfig(member.orgId, 0, BUDGET);

  const client = await userClient(member.email, member.password);
  const admin = adminClient();

  // Reservation #1: resolved (finalized as failed) WITHOUT ever issuing a
  // token for it at all -- e.g. a crash between reserving and issuing, in
  // the real flow. Attempting to issue a token for it now must fail with
  // VT205, proving that check is real, not merely documented.
  const reservation1 = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt1@example.com",
  });
  expect(reservation1.error).toBeNull();
  const logId1 = reservation1.data!;

  const preemptiveFinalize = await admin.rpc("finalize_notification_email_change_send", {
    p_log_id: logId1,
    p_delivered: false,
  });
  expect(preemptiveFinalize.error).toBeNull();

  const issueAfterResolved = await admin.rpc("issue_notification_email_change_token", { p_log_id: logId1 });
  expect(issueAfterResolved.data).toBeNull();
  expect(issueAfterResolved.error?.code).toBe("VT205");

  // Reservation #2, same organization, same tiny budget: this is the
  // settings-actions.ts scenario itself -- issuance fails for reservation
  // #2, the finally block finalizes it as failed (exactly the same RPC
  // call the test above already proved frees budget), and capacity must
  // still be available for a THIRD, later attempt despite two prior
  // reservations against a budget of only 2.
  const reservation2 = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt2@example.com",
  });
  expect(reservation2.error).toBeNull();
  const logId2 = reservation2.data!;
  const finalizeIssuanceFailure = await admin.rpc("finalize_notification_email_change_send", {
    p_log_id: logId2,
    p_delivered: false,
  });
  expect(finalizeIssuanceFailure.error).toBeNull();

  const reservation3 = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt3@example.com",
  });
  expect(reservation3.error).toBeNull();
});

/**
 * Round-6 finding R6-04: finalize_notification_email_change_send used to
 * be callable by `authenticated` with a caller-supplied delivery result
 * (and an ownership check standing in for authorization) -- a client could
 * mark its own reservation delivered/failed at will, generating excessive
 * failed-reservation records or otherwise interfering with the budget's
 * own accounting. Now service_role-only; no authenticated caller, from
 * this organization or any other, can call it at all.
 */
test("R6-04: an authenticated client cannot call finalize_notification_email_change_send directly (service_role only)", async () => {
  const client = await userClient(member.email, member.password);
  const { data: logId } = await client.rpc("reserve_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });

  const { error } = await client.rpc("finalize_notification_email_change_send", {
    p_log_id: logId!,
    p_delivered: true,
  });
  expect(error?.message).toContain("permission denied for function");

  // The reservation must still be untouched -- confirmed directly against
  // the database, since private.notification_email_change_log isn't
  // exposed to PostgREST.
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const { rows } = await dbClient!.query("select status from private.notification_email_change_log where id = $1", [
    logId,
  ]);
  expect(rows[0]?.status).toBe("reserved");
});

function userClientAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
