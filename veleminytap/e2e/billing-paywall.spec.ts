import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  type SeededOrgMember,
} from "./support/seed";

/**
 * The subscription paywall (app/dashboard/layout.tsx) must gate the
 * operator dashboard only -- never the public NFC/feedback pages. This is
 * the same non-negotiable shape as the Google-Review non-gating invariant
 * (see review-gating.spec.ts): a card already sold and sitting on a
 * customer's counter must keep collecting real feedback regardless of
 * whether its organization's subscription has lapsed. See DECISIONS.md.
 */

let member: SeededOrgMember;

test.afterEach(async () => {
  if (member) await cleanupOrgWithMember(member.userId, member.orgId);
});

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(email);
  await page.getByLabel("Jelszó").fill(password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
}

test("a freshly signed-up organization (still inside its trial) can reach the dashboard", async ({
  page,
}) => {
  member = await seedOrgWithMember("billing-trial");
  await login(page, member.email, member.password);
  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("an organization with no active subscription is redirected from the dashboard to the billing page", async ({
  page,
}) => {
  member = await seedOrgWithMember("billing-lapsed");
  const admin = adminClient();
  // organizations_after_insert_provision_trial (see the billing migration)
  // already created a 'trialing' row for this org -- overwrite it into a
  // clearly-inactive state, the same as a canceled or failed subscription.
  const { error } = await admin
    .from("organization_billing")
    .update({ status: "canceled", trial_ends_at: null })
    .eq("organization_id", member.orgId);
  expect(error).toBeNull();

  await login(page, member.email, member.password);
  await page.waitForURL(/\/dashboard\/billing$/);
  await expect(page.getByRole("heading", { name: "Számlázás" })).toBeVisible();

  // Trying to navigate to another dashboard route directly bounces back too
  // -- not just the initial post-login landing.
  await page.goto("/dashboard/feedback");
  await page.waitForURL(/\/dashboard\/billing$/);
});

test("the billing page itself never redirects, even when inactive -- no redirect loop", async ({
  page,
}) => {
  member = await seedOrgWithMember("billing-loop-check");
  const admin = adminClient();
  await admin
    .from("organization_billing")
    .update({ status: "canceled", trial_ends_at: null })
    .eq("organization_id", member.orgId);

  await login(page, member.email, member.password);
  await page.waitForURL(/\/dashboard\/billing$/);
  await page.goto("/dashboard/billing");
  await expect(page.getByRole("heading", { name: "Számlázás" })).toBeVisible();
});

test("public feedback submission keeps working even when the organization's subscription is inactive", async ({
  page,
}) => {
  member = await seedOrgWithMember("billing-public-unaffected");
  const admin = adminClient();
  await admin
    .from("organization_billing")
    .update({ status: "canceled", trial_ends_at: null })
    .eq("organization_id", member.orgId);

  const card = await seedActiveCard(member.orgId, "billing-public-unaffected");

  // No login at all here -- this is the actual unauthenticated customer
  // flow, exactly like review-gating.spec.ts and public-submission-safety.spec.ts.
  await page.goto(`/r/${card.publicId}`);
  await page.getByRole("radio", { name: /^5 csillag —/ }).click();
  await page.getByRole("button", { name: "Vélemény küldése" }).click();

  const { data: feedback, error } = await admin
    .from("feedback")
    .select("id, rating")
    .eq("nfc_card_id", card.cardId)
    .single();
  expect(error).toBeNull();
  expect(feedback?.rating).toBe(5);
});
