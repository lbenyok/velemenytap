import { test, expect } from "@playwright/test";
import {
  seedPlainUser,
  cleanupPlainUser,
  userClient,
  adminClient,
  type SeededPlainUser,
} from "./support/seed";

/**
 * Finding #8: createOrganizationAction used to do two separate admin-client
 * inserts (organization, then membership) with no transaction across them,
 * and nothing stopped a double-submit from creating a second organization
 * for the same user. Fixed with create_organization_atomic -- a single
 * atomic, idempotent database function with per-user serialization via an
 * advisory lock (see its migration). These tests call the RPC directly
 * (bypassing the UI) to drive the exact concurrency scenario the fix
 * targets, which a browser can't reliably reproduce.
 */

let user: SeededPlainUser;

test.beforeEach(async () => {
  user = await seedPlainUser("onboarding");
});

test.afterEach(async () => {
  await cleanupPlainUser(user.userId);
});

test("the real onboarding form creates an organization and lands on the dashboard", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(user.email);
  await page.getByLabel("Jelszó").fill(user.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();

  await page.waitForURL(/\/onboarding$/);
  await page.getByLabel("Vállalkozás neve").fill("E2E UI Onboarding Test");
  await page.getByRole("button", { name: "Tovább" }).click();

  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: /E2E UI Onboarding Test/ })).toBeVisible();
});

test("creates exactly one organization and owner membership", async () => {
  const client = await userClient(user.email, user.password);
  const { data, error } = await client
    .rpc("create_organization_atomic", { p_name: "Kávézó Búza" })
    .single();

  expect(error).toBeNull();
  expect(data?.newly_created).toBe(true);
  expect(data?.organization_name).toBe("Kávézó Búza");
  // The removed JS slugify() stripped accents before collapsing
  // non-alphanumeric characters (a Hungarian business name routinely
  // contains them); the SQL version must do the same via unaccent(), not
  // turn every accented letter into its own hyphen.
  expect(data?.organization_slug).toBe("kavezo-buza");

  const admin = adminClient();
  const { data: memberships } = await admin
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.userId);
  expect(memberships).toHaveLength(1);
  expect(memberships?.[0].role).toBe("owner");
});

test("idempotent: a second call for the same user returns the existing organization instead of creating another", async () => {
  const client = await userClient(user.email, user.password);

  const first = await client.rpc("create_organization_atomic", { p_name: "First Org" }).single();
  expect(first.error).toBeNull();
  expect(first.data?.newly_created).toBe(true);

  const second = await client
    .rpc("create_organization_atomic", { p_name: "Second Attempt" })
    .single();
  expect(second.error).toBeNull();
  expect(second.data?.newly_created).toBe(false);
  expect(second.data?.organization_id).toBe(first.data?.organization_id);
  // The second call's name argument must NOT overwrite anything -- it
  // returns the first org untouched.
  expect(second.data?.organization_name).toBe("First Org");

  const admin = adminClient();
  const { data: orgs } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", user.userId);
  expect(orgs).toHaveLength(1);
});

test("per-user serialization: two concurrent calls for the same user still create only one organization", async () => {
  const client = await userClient(user.email, user.password);

  // Fired together, not awaited one at a time -- this is the exact race a
  // plain "check for an existing org, then insert" would lose: both
  // requests could pass the check before either commits.
  const [a, b] = await Promise.all([
    client.rpc("create_organization_atomic", { p_name: "Race A" }).single(),
    client.rpc("create_organization_atomic", { p_name: "Race B" }).single(),
  ]);

  expect(a.error).toBeNull();
  expect(b.error).toBeNull();

  const createdCount = [a.data?.newly_created, b.data?.newly_created].filter(Boolean).length;
  expect(createdCount).toBe(1);
  expect(a.data?.organization_id).toBe(b.data?.organization_id);

  const admin = adminClient();
  const { data: memberships } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", user.userId);
  expect(memberships).toHaveLength(1);
});

test("slug collision falls back to a suffixed slug instead of failing", async () => {
  const admin = adminClient();
  const { error: seedError } = await admin
    .from("organizations")
    .insert({ name: "Taken", slug: "taken" });
  expect(seedError).toBeNull();

  const client = await userClient(user.email, user.password);
  const { data, error } = await client.rpc("create_organization_atomic", { p_name: "Taken" }).single();

  expect(error).toBeNull();
  expect(data?.organization_slug).not.toBe("taken");
  expect(data?.organization_slug?.startsWith("taken-")).toBe(true);

  await admin.from("organizations").delete().eq("slug", "taken");
});
