import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedFeedbackFixture,
  userClient,
  adminClient,
  addOrgMember,
  type SeededOrgMember,
  type SeededFeedbackFixture,
} from "./support/seed";
import { signInViaUi } from "./support/ui";

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

test("Org A cannot update Org B's onboarding_tour_status", async () => {
  // organizations_update's USING/WITH CHECK is private.is_org_member(id) --
  // broad by column (any member can update any of their own org's columns),
  // so this is the one column-specific check worth its own test: does that
  // membership check actually stop Org A from touching Org B's row at all,
  // the same guarantee already relied on for name/logo_url via the same
  // policy.
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .from("organizations")
    .update({ onboarding_tour_status: "skipped" })
    .eq("id", orgB.orgId)
    .select("id");

  expect(data).toEqual([]);

  const clientB = await userClient(orgB.email, orgB.password);
  const { data: unchanged } = await clientB
    .from("organizations")
    .select("onboarding_tour_status")
    .eq("id", orgB.orgId)
    .single();
  expect(unchanged?.onboarding_tour_status).toBe("completed");
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
  await signInViaUi(page, orgA.email, orgA.password);
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/dashboard/feedback");
  await expect(page.getByText("Még nincs vélemény")).toBeVisible();
  // Org B's feedback fixture has distinctive text -- it must never render
  // in Org A's inbox no matter how the page is reached.
  await expect(page.getByText("Original feedback text")).toHaveCount(0);
});

/**
 * Membership rows are the root of every other check in this file: the RLS
 * policies on organizations, locations, nfc_cards and feedback all resolve
 * through `private.is_org_member(organization_id)`. Whoever can write a
 * membership row can grant themselves everything else.
 *
 * `organization_memberships` has a SELECT policy and NOTHING else, so with RLS
 * enabled there is no INSERT, UPDATE or DELETE path for `authenticated` at
 * all -- the boundary is held by the ABSENCE of a policy rather than by the
 * presence of a restrictive one, which is precisely the kind of guarantee a
 * later migration can dissolve without anything looking wrong. Nothing tested
 * it; these three do.
 *
 * The role column matters more than it currently appears to. `canManageBilling`
 * is the only role check in the entire application -- every other tenant
 * mutation (locations, cards, feedback status and notes, organization
 * settings) is open to any member regardless of role. That is not reachable
 * today, because the only code path that creates a membership is
 * `create_organization_atomic`, which always writes `owner`, and there is no
 * invitation flow. It becomes reachable the moment one ships.
 */
test("a member cannot promote themselves by updating their own membership row", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { data } = await clientA
    .from("organization_memberships")
    .update({ role: "owner" })
    .eq("user_id", orgA.userId)
    .select("id");

  // Zero rows affected, not an error: with no UPDATE policy the row is simply
  // invisible to the write. Asserting the row is unchanged afterwards is what
  // makes this a real check rather than a check on the shape of the response.
  expect(data).toEqual([]);

  const { data: unchanged } = await clientA
    .from("organization_memberships")
    .select("role")
    .eq("user_id", orgA.userId)
    .single();
  expect(unchanged?.role).toBe("owner");

  // Non-vacuity control. A zero-row result also happens when the filter
  // matches nothing or the column does not exist -- in which case this test
  // would pass forever while proving nothing about RLS. The identical write
  // through the admin client (service_role, which bypasses RLS by design)
  // must affect exactly one row, which establishes that the row is real,
  // the column is writable, and the ONLY reason the member could not do it
  // is the missing policy.
  const admin = adminClient();
  const { data: adminUpdated } = await admin
    .from("organization_memberships")
    .update({ role: "admin" })
    .eq("user_id", orgA.userId)
    .select("id");
  expect(adminUpdated).toHaveLength(1);
  await admin
    .from("organization_memberships")
    .update({ role: "owner" })
    .eq("user_id", orgA.userId);
});

test("a member cannot insert a membership for themselves into another organization", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  const { error } = await clientA
    .from("organization_memberships")
    .insert({ organization_id: orgB.orgId, user_id: orgA.userId, role: "owner" });

  expect(error).not.toBeNull();

  // And Org B's roster is genuinely untouched -- read as Org B, since Org A
  // cannot see it either way and an empty read would prove nothing.
  const clientB = await userClient(orgB.email, orgB.password);
  const { data: roster } = await clientB
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", orgB.orgId);
  expect(roster?.map((r) => r.user_id)).toEqual([orgB.userId]);
});

test("a member cannot delete a membership row", async () => {
  const clientA = await userClient(orgA.email, orgA.password);
  await clientA.from("organization_memberships").delete().eq("user_id", orgA.userId);

  const { count } = await clientA
    .from("organization_memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", orgA.userId);
  expect(count).toBe(1);
});

/**
 * Round-14 R14-04. `getCurrentOrganization` resolved "the earliest membership
 * row I can SEE" and called it "my membership". Those differ: the roster is
 * readable by every member of the organization -- deliberately, and the
 * dashboard needs it -- so ordering it by `created_at` and taking the first row
 * hands a later STAFF member the earlier OWNER's row, and `role` came back as
 * `owner`.
 *
 * `canManageBilling(organization.role)` reads that value directly, which made
 * the one role check in the application a check on a role that need not belong
 * to the caller. Unreachable in the shipped product -- the only
 * membership-creating path writes `owner` and there is no invite flow -- but
 * unreachable for a reason unrelated to why it was wrong, which is not a
 * property worth relying on.
 *
 * Asserted end to end rather than by inspecting the resolver: a staff member
 * who submits the real checkout form must land on `error=unauthorized`.
 */
test("a staff member is resolved as staff, not as the organization's owner", async ({ page }) => {
  const staff = await addOrgMember(orgA.orgId, "tenant-isolation-staff", "staff");
  try {
    await signInViaUi(page, staff.email, staff.password);
    await page.waitForURL("/dashboard");

    await page.goto("/dashboard/billing");
    await page.getByRole("button", { name: "Előfizetek" }).first().click();

    // The refusal canManageBilling produces. Before the fix this member
    // resolved as `owner` and the action proceeded past this gate entirely.
    await page.waitForURL(/\/dashboard\/billing\?error=unauthorized/, { timeout: 15_000 });
  } finally {
    const admin = adminClient();
    await admin.from("organization_memberships").delete().eq("user_id", staff.userId);
    await admin.auth.admin.deleteUser(staff.userId);
  }
});
