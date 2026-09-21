import { test, expect } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, seedActiveCard, userClient } from "./support/seed";
import { signInViaUi } from "./support/ui";

test("owner can choose automatic grace, enforce all public links and return to manual without clearing card locks", async ({ page, browser }) => {
  test.setTimeout(180000);
  const owner = await seedOrgWithMember("monitor-owner");
  const customer = await seedOrgWithMember("monitor-customer");
  const admin = adminClient();
  const context = await browser.newContext();
  try {
    expect((await admin.from("platform_admins").insert({ user_id: owner.userId })).error).toBeNull();
    const card = await seedActiveCard(customer.orgId, "monitor-card");
    expect((await admin.from("organization_billing").update({ stripe_customer_id: null, stripe_subscription_id: null, status: "canceled", activated_at: null, grandfathered_at: null, trial_ends_at: "2020-01-01T00:00:00Z" }).eq("organization_id", customer.orgId)).error).toBeNull();
    await signInViaUi(page, owner.email, owner.password, `/admin?org=${customer.orgId}`);
    await expect(page.getByLabel("Nemfizetés kezelése")).toHaveValue("manual");
    await expect(page.getByLabel("Türelmi idő (nap)")).toHaveValue("3");
    await page.getByLabel("Nemfizetés kezelése").selectOption("automatic");
    await page.getByRole("button", { name: "Fizetési mód mentése", exact: true }).click();
    await expect(page.getByText("Türelmi idő", { exact: true })).toBeVisible();
    const visitor = await context.newPage();
    await visitor.goto(`/r/${card.publicId}`);
    await expect(visitor.getByRole("radiogroup")).toBeVisible();
    const tenant = await userClient(customer.email, customer.password);
    expect((await tenant.from("billing_card_controls").update({ blocked: false, mode: "manual" }).eq("organization_id", customer.orgId)).error).not.toBeNull();
    expect((await admin.from("billing_card_controls").update({ overdue_since: "2020-01-01T00:00:00Z" }).eq("organization_id", customer.orgId)).error).toBeNull();
    await page.getByRole("button", { name: "Fizetés ellenőrzése most", exact: true }).click();
    await expect(page.getByText("Automatikus fizetési tiltás", { exact: true })).toBeVisible();
    expect((await admin.rpc("submit_feedback_atomic", { p_public_id: card.publicId, p_rating: 5, p_feedback_text: null })).error?.code).toBe("VT002");
    await visitor.reload();
    await expect(visitor.getByText("Ez a VéleményTap kártya jelenleg nem aktív.", { exact: true })).toBeVisible();
    expect((await admin.rpc("set_platform_card_lock", { p_actor_id: owner.userId, p_card_id: card.cardId, p_locked: true, p_expected_locked: false, p_reason: "Lost physical card" })).error).toBeNull();
    await page.getByLabel("Nemfizetés kezelése").selectOption("manual");
    await page.getByRole("button", { name: "Fizetési mód mentése", exact: true }).click();
    await expect(page.getByText("Tulajdonos által zárolva", { exact: true })).toBeVisible();
    await expect.poll(async () => (await admin.from("billing_card_controls").select("blocked").eq("organization_id", customer.orgId).single()).data?.blocked).toBe(false);
    await visitor.reload();
    await expect(visitor.getByRole("radiogroup")).toHaveCount(0);
  } finally {
    await context.close();
    await admin.from("platform_card_audit").delete().eq("organization_id", customer.orgId);
    await cleanupOrgWithMember(customer.userId, customer.orgId);
    await cleanupOrgWithMember(owner.userId, owner.orgId);
  }
});
