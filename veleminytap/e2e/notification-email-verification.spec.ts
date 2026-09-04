import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
  userClient,
  type SeededOrgMember,
} from "./support/seed";

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

test.beforeEach(async () => {
  member = await seedOrgWithMember("notif-email-verify");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("R3-03: requesting a new address sets it as pending, not active", async () => {
  const client = await userClient(member.email, member.password);
  const { data: token, error } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
  expect(error).toBeNull();
  expect(typeof token).toBe("string");
  expect(token!.length).toBeGreaterThan(20);

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
  const { data: token } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });

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
  // Already expired the instant it's created -- exercises the expiry
  // boundary directly, without waiting a real 24 hours or writing to a
  // column the enforcement trigger blocks even the admin client from
  // touching directly.
  const { data: token } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
    p_expires_in_minutes: -1,
  });

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
  const client = await userClient(member.email, member.password);
  const { data: firstToken } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "first@example.com",
  });
  const { data: secondToken } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "second@example.com",
  });
  expect(firstToken).not.toBe(secondToken);

  const admin = adminClient();

  const firstAttempt = await admin.rpc("confirm_notification_email_change", { p_token: firstToken! });
  expect(firstAttempt.data).toBeNull();

  const secondAttempt = await admin.rpc("confirm_notification_email_change", { p_token: secondToken! });
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
  const { data: token } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });

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

  // Requested directly through the RPC, not the Settings form -- the form
  // submission also tries to send the confirmation email via Resend, which
  // is deliberately unconfigured in this test project (e2e/README.md), so
  // going through the RPC isolates what this test actually cares about:
  // how the Settings page RENDERS a pending request and what visiting the
  // confirm link does, not whether email-sending itself is available.
  const client = await userClient(member.email, member.password);
  const { data: token } = await client.rpc("request_notification_email_change", {
    p_organization_id: member.orgId,
    p_email: "candidate@example.com",
  });
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

function userClientAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
