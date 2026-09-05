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
 * stores a candidate address as PENDING alongside a hashed, expiring,
 * single-use token (returned once, in plaintext, to the caller -- the app
 * emails it as a link); confirm_notification_email_change() promotes it to
 * the active notification_email only when called with a token whose hash
 * matches a non-expired pending request. Until confirmed, notification_email
 * itself is untouched -- so alerts keep going to verified
 * owner/admin/manager members via the existing fallback in
 * features/notifications/negative-feedback-alert.ts, not the new address.
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

test("R3-03: requesting a new address sets it as pending, not active", async () => {
  const client = await userClient(member.email, member.password);
  const { data, error } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "candidate@example.com",
    })
    .single();
  expect(error).toBeNull();
  expect(typeof data?.token).toBe("string");
  expect(data!.token.length).toBeGreaterThan(20);

  const admin = adminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("notification_email, notification_email_pending")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBeNull();
  expect(org?.notification_email_pending).toBe("candidate@example.com");
});

test("R3-03: confirming with the correct token promotes the pending address to active", async () => {
  const client = await userClient(member.email, member.password);
  const { data } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "candidate@example.com",
    })
    .single();

  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: data!.token,
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
  // Already expired the instant it's created -- exercises the expiry
  // boundary directly, without waiting a real 24 hours or writing to a
  // column the enforcement trigger blocks even the admin client from
  // touching directly.
  const { data } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "candidate@example.com",
      p_expires_in_minutes: -1,
    })
    .single();

  const admin = adminClient();
  const { data: confirmedOrgId, error } = await admin.rpc("confirm_notification_email_change", {
    p_token: data!.token,
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
  const client = await userClient(member.email, member.password);
  const { data: first } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "first@example.com",
      // Round-5 R5-12's cooldown would otherwise reject this test's own
      // second request -- same tunable-parameter testability pattern as
      // p_expires_in_minutes above (see claim_negative_alert_send too).
      p_cooldown_minutes: 0,
    })
    .single();
  const { data: second } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "second@example.com",
      p_cooldown_minutes: 0,
    })
    .single();
  expect(first!.token).not.toBe(second!.token);

  const admin = adminClient();

  const firstAttempt = await admin.rpc("confirm_notification_email_change", { p_token: first!.token });
  expect(firstAttempt.data).toBeNull();

  const secondAttempt = await admin.rpc("confirm_notification_email_change", { p_token: second!.token });
  expect(secondAttempt.data).toBe(member.orgId);

  const { data: org } = await admin
    .from("organizations")
    .select("notification_email")
    .eq("id", member.orgId)
    .single();
  expect(org?.notification_email).toBe("second@example.com");
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
  const { data } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "candidate@example.com",
    })
    .single();

  const anonClient = userClientAnon();
  const anonAttempt = await anonClient.rpc("confirm_notification_email_change", { p_token: data!.token });
  expect(anonAttempt.error?.message).toContain("permission denied for function");

  const authAttempt = await client.rpc("confirm_notification_email_change", { p_token: data!.token });
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

  // Requested directly through the RPC, not the Settings form -- the form
  // submission also tries to send the confirmation email via Resend, which
  // is deliberately unconfigured in this test project (e2e/README.md), so
  // going through the RPC isolates what this test actually cares about:
  // how the Settings page RENDERS a pending request and what visiting the
  // confirm link does, not whether email-sending itself is available.
  const client = await userClient(member.email, member.password);
  const { data } = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "candidate@example.com",
    })
    .single();
  expect(data?.token).not.toBeNull();

  await page.goto("/dashboard/settings");
  await expect(page.getByText("Megerősítésre vár:")).toBeVisible();
  await expect(page.getByText("candidate@example.com")).toBeVisible();
  // The active field itself is still empty -- the pending address hasn't
  // become the real notification_email yet.
  await expect(page.getByLabel("Értesítési e-mail cím")).toHaveValue("");

  await page.goto(`/api/notification-email/confirm?token=${encodeURIComponent(data!.token)}`);
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
 * the negative-feedback alert; these tests exercise it the same way that
 * one already is (a real cooldown rejection, a real concurrent race
 * against the budget, and a failed send not permanently burning it).
 */
test("R5-12: a second request within the cooldown window is rejected", async () => {
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
  const client = await userClient(member.email, member.password);
  const BUDGET = 1;

  // Cooldown disabled (0 minutes) specifically to isolate the budget from
  // it -- unlike the per-CARD alert cooldown, this one is per-ORGANIZATION,
  // so every concurrent call here would otherwise collide with it first
  // rather than exercising the budget check at all.
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      client.rpc("request_notification_email_change", {
        p_organization_id: member.orgId,
        p_email: `candidate-${i}@example.com`,
        p_cooldown_minutes: 0,
        p_org_hourly_budget: BUDGET,
      }),
    ),
  );

  const succeeded = results.filter((r) => r.error === null);
  const budgetExceeded = results.filter((r) => r.error?.code === "VT204");
  expect(succeeded).toHaveLength(BUDGET);
  expect(budgetExceeded).toHaveLength(5 - BUDGET);
});

test("R5-12: a failed send does not permanently consume the budget it never actually used", async () => {
  const client = await userClient(member.email, member.password);
  const BUDGET = 1;

  const attempt1 = await client
    .rpc("request_notification_email_change", {
      p_organization_id: member.orgId,
      p_email: "attempt1@example.com",
      p_cooldown_minutes: 0,
      p_org_hourly_budget: BUDGET,
    })
    .single();
  expect(attempt1.error).toBeNull();

  // Report it as a FAILED send (Resend rejected it, network error, etc.)
  // -- finalize_notification_email_change_send marks the reservation
  // 'failed', which the budget query excludes.
  const finalize = await client.rpc("finalize_notification_email_change_send", {
    p_log_id: attempt1.data!.log_id,
    p_delivered: false,
  });
  expect(finalize.error).toBeNull();

  // A second attempt, same tiny budget -- must succeed, because the first
  // one's failure freed the budget slot it reserved but never delivered.
  const attempt2 = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "attempt2@example.com",
    p_cooldown_minutes: 0,
    p_org_hourly_budget: BUDGET,
  });
  expect(attempt2.error).toBeNull();
});

test("R5-12: finalize_notification_email_change_send cannot be used to resolve another organization's reservation", async () => {
  test.skip(!dbClient, "No direct Postgres connection available in this environment.");
  const other = await seedOrgWithMember("notif-email-verify-finalize-other");
  try {
    const client = await userClient(member.email, member.password);
    const { data } = await client
      .rpc("request_notification_email_change", {
        p_organization_id: member.orgId,
        p_email: "candidate@example.com",
      })
      .single();

    const otherClient = await userClient(other.email, other.password);
    const { error } = await otherClient.rpc("finalize_notification_email_change_send", {
      p_log_id: data!.log_id,
      p_delivered: true,
    });
    // No error is raised (the function just silently matches zero rows --
    // the same "no ownership, no effect" shape as finalize_negative_alert_send's
    // `where status = 'reserved'` idempotency guard) -- what matters is the
    // reservation's actual status, checked directly against the database
    // (private.notification_email_change_log isn't exposed to PostgREST),
    // which must still be 'reserved', not 'delivered'.
    expect(error).toBeNull();

    const { rows } = await dbClient!.query("select status from private.notification_email_change_log where id = $1", [
      data!.log_id,
    ]);
    expect(rows[0]?.status).toBe("reserved");
  } finally {
    await cleanupOrgWithMember(other.userId, other.orgId);
  }
});

function userClientAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
