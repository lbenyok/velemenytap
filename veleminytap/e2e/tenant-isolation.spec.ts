import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedFeedbackFixture,
  userClient,
  type SeededOrgMember,
  type SeededFeedbackFixture,
} from "./support/seed";

/**
 * Finding #10: dedicated cross-tenant isolation coverage. Every other test
 * file in this suite tests one organization's own RLS boundary (can this
 * member do X to their own org's data); this file specifically tests the
 * tenant boundary itself -- can Org A's member read or write ANY of Org B's
 * data, through their own real, signed-in, RLS-bound client (not the admin
 * client, which deliberately bypasses RLS and proves nothing about it).
 * Per the product skill's Security Checklist, this is the single most
 * important thing to get right in a multi-tenant SaaS -- treat any leak
 * here as critical severity.
 */

let orgA: SeededOrgMember;
let orgB: SeededOrgMember;
let fixtureB: SeededFeedbackFixture;

test.beforeEach(async () => {
  orgA = await seedOrgWithMember("tenant-isolation-a");
  orgB = await seedOrgWithMember("tenant-isolation-b");
  fixtureB = await seedFeedbackFixture(orgB.orgId, "tenant-isolation-b");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(orgA.userId, orgA.orgId);
  await cleanupOrgWithMember(orgB.userId, orgB.orgId);
});

test("Org A cannot read Org B's organization row", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { data, error } = await clientA.from("organizations").select("*").eq("id", orgB.orgId);

  // RLS filters rather than erroring -- an unauthorized SELECT returns an
  // empty result, not a 403. Both matter: no error AND no leaked row.
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test("Org A cannot read Org B's locations, nfc_cards, or feedback", async () => {
  const clientA = await userClient(orgA.email, orgA.password);

  const [locations, cards, feedback] = await Promise.all([
    clientA.from("locations").select("*").eq("organization_id", orgB.orgId),
    clientA.from("nfc_cards").select("*").eq("organization_id", orgB.orgId),
    clientA.from("feedback").select("*").eq("organization_id", orgB.orgId),
  ]);

  expect(locations.data).toEqual([]);
  expect(cards.data).toEqual([]);
  expect(feedback.data).toEqual([]);
});

test("Org A cannot read Org B's membership roster", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", orgB.orgId);

  expect(data).toEqual([]);
});

test("Org A cannot update Org B's feedback status", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .from("feedback")
    .update({ status: "resolved" })
    .eq("id", fixtureB.feedbackId)
    .select("id");

  // No matching row under Org A's RLS view -- zero rows affected, not an
  // error and not a successful mutation of someone else's data.
  expect(data).toEqual([]);

  const clientB = await userClient(orgB.email, orgB.password);
  const { data: unchanged } = await clientB
    .from("feedback")
    .select("status")
    .eq("id", fixtureB.feedbackId)
    .single();
  expect(unchanged?.status).toBe("new");
});

test("Org A cannot update Org B's nfc_card", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .from("nfc_cards")
    .update({ status: "inactive" })
    .eq("id", fixtureB.cardId)
    .select("id");

  expect(data).toEqual([]);
});

test("Org A cannot insert a location directly into Org B", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { error } = await clientA
    .from("locations")
    .insert({ organization_id: orgB.orgId, name: "Injected location" });

  // The INSERT policy's WITH CHECK requires membership in the target org --
  // Org A's client is a member of neither, so this must be rejected, not
  // silently redirected into Org A's own org or accepted at all.
  expect(error).not.toBeNull();
});

test("Org A cannot insert an nfc_card directly into Org B's location", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { error } = await clientA
    .from("nfc_cards")
    .insert({ organization_id: orgB.orgId, location_id: fixtureB.locationId, display_name: "x" });

  expect(error).not.toBeNull();
});

test("Org A's onboarding RPC cannot be used to join or read Org B", async () => {
  // create_organization_atomic is idempotent per-user (finding #8) -- Org
  // A's user already has an org, so calling it again must return Org A's
  // own organization, never Org B's, regardless of what name is passed.
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .rpc("create_organization_atomic", { p_name: "Attempted takeover" })
    .single();

  expect(data?.organization_id).toBe(orgA.orgId);
  expect(data?.organization_id).not.toBe(orgB.orgId);
});

test("Org A's dashboard shows only Org A's data, never Org B's", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(orgA.email);
  await page.getByLabel("Jelszó").fill(orgA.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/dashboard/feedback");
  await expect(page.getByText("Még nincs vélemény")).toBeVisible();
  // Org B's feedback fixture has distinctive text -- it must never render
  // in Org A's inbox no matter how the page is reached.
  await expect(page.getByText("Original feedback text")).toHaveCount(0);
});
