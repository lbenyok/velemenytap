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

/**
 * Round-3 finding R3-03. An organization's notification_email used to be
 * written directly, with no proof the org actually controlled the
 * address -- a real spam-relay risk once combined with round-2's
 * budget-limited (but still real) email sending capability.
 *
 * Fixed with a genuine confirmation flow: request_notification_email_change()
 * validates and rate-limits, then reserves a pending address; the actual
 * confirmation token is minted separately (round-6 R6-01, see below) and
 * emailed as a link; confirm_notification_email_change() promotes the
 * pending address to the active notification_email only when called with a
 * token whose hash matches a non-expired pending request.
 *
 * Round-6 finding R6-01 (HIGH): request_notification_email_change() used
 * to return the raw token directly to its `authenticated` caller -- so any
 * org member could call the RPC directly (bypassing the settings Server
 * Action and Resend entirely) and read a live token out of the response,
 * confirming an arbitrary address without ever proving control of its
 * inbox. Fixed by splitting the token out into a separate function,
 * issue_notification_email_change_token(), granted to `service_role`
 * ONLY -- reachable exclusively from trusted server code via the admin
 * client. request_notification_email_change() now returns only a log_id.
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
  const { data: logId, error: requestError } = await client.rpc("request_notification_email_change", {
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
  const { data: logId, error } = await client.rpc("request_notification_email_change", {
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

test("R6-01: request_notification_email_change does not return the token -- it must be issued separately", async () => {
  // This is the direct regression test for the vulnerability: the raw
  // response from the authenticated-callable RPC must never contain
  // anything that looks like the 64-hex-character token
  // issue_notification_email_change_token() would otherwise mint.
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
  expect(error).toBeNull();
  expect(typeof data).toBe("number");
  expect(JSON.stringify(data)).not.toMatch(/^[0-9a-f]{64}$/);
});

test("R6-01: an authenticated client cannot call issue_notification_email_change_token directly (service_role only)", async () => {
  const client = await userClient(member.email, member.password);
  const { data: logId } = await client.rpc("request_notification_email_change", {
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
  const client = await userClient(member.email, member.password);
  // Calling with the OLD, now-removed parameter names must fail as "no
  // matching function", not silently ignore them and succeed -- proving
  // there is no overload a client could still hit to tune its own limits.
  const { data, error } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
    p_cooldown_minutes: 0,
    p_org_hourly_budget: 999999,
  });
  expect(data).toBeNull();
  expect(error).not.toBeNull();
});

test("R6-01: the round-3 3-argument function is no longer callable by authenticated (its live token-leak grant was revoked)", async () => {
  const client = await userClient(member.email, member.password);
  const { data, error } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
    p_expires_in_minutes: 1440,
  });
  expect(data).toBeNull();
  expect(error).not.toBeNull();
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
 * request_notification_email_change() call for the same org, landing
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
  await client.rpc("request_notification_email_change", {
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
    const { error } = await otherClient.rpc("request_notification_email_change", {
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
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
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
 * Round-5 finding R5-12: request_notification_email_change() had no
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
  const first = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "first@example.com",
  });
  expect(first.error).toBeNull();

  const second = await client.rpc("request_notification_email_change", {
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
      client.rpc("request_notification_email_change", {
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

test("R5-12: a failed send does not permanently consume the budget it never actually used", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const BUDGET = 1;
  await setRateLimitConfig(member.orgId, 0, BUDGET);

  const client = await userClient(member.email, member.password);
  const attempt1 = await client.rpc("request_notification_email_change", {
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
  const attempt2 = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt2@example.com",
  });
  expect(attempt2.error).toBeNull();
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
  const { data: logId } = await client.rpc("request_notification_email_change", {
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
