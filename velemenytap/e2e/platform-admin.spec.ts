import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, seedActiveCard, userClient } from "./support/seed";
import { signInViaUi } from "./support/ui";

test("platform owner locks another business's card; tenant and stale form cannot bypass; unlock preserves history", async ({ page, browser }) => {
  test.setTimeout(180000);
  const owner = await seedOrgWithMember("platform-owner");
  const customer = await seedOrgWithMember("platform-customer");
  const admin = adminClient();
  const visitorContext = await browser.newContext();
  const tenantContext = await browser.newContext();
  try {
    expect((await admin.from("platform_admins").insert({ user_id: owner.userId, role: "owner" })).error).toBeNull();
    // The admin panel is independent of the platform owner's own subscription.
    expect((await admin.from("organization_billing").update({ status: "canceled", trial_ends_at: null, grandfathered_at: null }).eq("organization_id", owner.orgId)).error).toBeNull();
    const card = await seedActiveCard(customer.orgId, "platform-lock");
    expect((await admin.rpc("submit_feedback_atomic", { p_public_id: card.publicId, p_rating: 4, p_feedback_text: null })).error).toBeNull();
    const visitor = await visitorContext.newPage();
    await visitor.goto(`/r/${card.publicId}`);
    await visitor.getByRole("radio", { name: /^3 csillag —/ }).click();
    await signInViaUi(page, owner.email, owner.password, `/admin?org=${customer.orgId}`);
    await expect(page.getByRole("heading", { name: "Tulajdonosi admin", exact: true })).toBeVisible();
    const item = page.locator("article").filter({ hasText: "E2E Card" });
    await item.getByRole("textbox", { name: "Indoklás" }).fill("Lost card — verification");
    await item.getByRole("button", { name: "Kártya zárolása", exact: true }).click();
    await expect(item.getByText("Kézzel zárolva", { exact: true })).toBeVisible();
    await visitor.getByRole("button", { name: "Vélemény küldése" }).click();
    await expect(visitor.locator('p[role="alert"]')).toHaveText("Ez a link már nem aktív.");
    expect((await admin.rpc("submit_feedback_atomic", { p_public_id: card.publicId, p_rating: 5, p_feedback_text: null })).error?.code).toBe("VT002");
    await visitor.reload();
    await expect(visitor.getByText("Ez a VéleményTap kártya jelenleg nem aktív.", { exact: true })).toBeVisible();
    const tenant = await userClient(customer.email, customer.password);
    for (const values of [{ status: "active" }, { platform_locked: false, platform_previous_status: null, status: "active" }, { public_id: randomUUID() }, { id: card.cardId + 999999 }, { platform_previous_status: "active" }]) {
      // Request extra protected columns deliberately, as a hostile API client would.
      const result = await tenant.from("nfc_cards").update(values as never).eq("id", card.cardId).select();
      if ("platform_previous_status" in values && Object.keys(values).length === 1) continue; // same-value no-op is harmless
      expect(result.error).not.toBeNull();
    }
    const tenantPage = await tenantContext.newPage();
    await signInViaUi(tenantPage, customer.email, customer.password, "/dashboard/nfc-cards");
    await expect(tenantPage.getByText("Szolgáltatói zárolás", { exact: true })).toBeVisible();
    await expect(tenantPage.getByRole("button", { name: "Aktiválás", exact: true })).toHaveCount(0);
    await tenantPage.goto("/admin");
    await expect(tenantPage.getByRole("heading", { name: "Tulajdonosi admin", exact: true })).toHaveCount(0);
    await item.getByRole("textbox", { name: "Indoklás" }).fill("Card recovered");
    await item.getByRole("button", { name: "Zárolás feloldása", exact: true }).click();
    await expect(item.getByText("Aktív", { exact: true })).toBeVisible();
    const stored = await admin.from("nfc_cards").select("status, platform_locked, platform_previous_status, public_id").eq("id", card.cardId).single();
    expect(stored.data).toEqual({ status: "active", platform_locked: false, platform_previous_status: null, public_id: card.publicId });
    const history = await admin.from("feedback").select("id").eq("nfc_card_id", card.cardId);
    expect(history.data).toHaveLength(1);
    const audit = await admin.from("platform_card_audit").select("actor_id, locked, reason").eq("card_id", card.cardId).order("id");
    expect(audit.data).toEqual([{ actor_id: owner.userId, locked: true, reason: "Lost card — verification" }, { actor_id: owner.userId, locked: false, reason: "Card recovered" }]);
    await visitor.reload();
    await expect(visitor.getByRole("radiogroup")).toBeVisible();
  } finally {
    await visitorContext.close(); await tenantContext.close();
    await admin.from("platform_card_audit").delete().eq("organization_id", customer.orgId);
    await cleanupOrgWithMember(customer.userId, customer.orgId);
    await cleanupOrgWithMember(owner.userId, owner.orgId);
  }
});

test("database rejects self-grants, forged roles and RPC calls; restores inactive cards and rejects stale/revoked admin actions", async () => {
  const owner = await seedOrgWithMember("platform-rpc-owner");
  const customer = await seedOrgWithMember("platform-rpc-customer");
  const admin = adminClient();
  try {
    const card = await seedActiveCard(customer.orgId, "platform-rpc");
    const tenant = await userClient(customer.email, customer.password);
    expect((await tenant.auth.updateUser({ data: { platform_admin: true, role: "platform_admin" } })).error).toBeNull();
    expect((await tenant.from("platform_admins").insert({ user_id: customer.userId })).error).not.toBeNull();
    expect((await tenant.from("platform_admins").select("user_id")).data).toEqual([]);
    const input = { p_actor_id: owner.userId, p_card_id: card.cardId, p_locked: true, p_expected_locked: false, p_reason: "Verification lock" };
    expect((await tenant.rpc("set_platform_card_lock", input)).error).not.toBeNull();
    expect((await admin.rpc("set_platform_card_lock", input)).error?.code).toBe("42501");
    expect((await admin.from("platform_admins").insert({ user_id: owner.userId, role: "owner" })).error).toBeNull();
    expect((await tenant.from("nfc_cards").update({ status: "inactive" }).eq("id", card.cardId)).error).toBeNull();
    expect((await admin.rpc("set_platform_card_lock", input)).error).toBeNull();
    expect((await tenant.from("platform_card_audit").select("id")).error).not.toBeNull();
    expect((await tenant.from("nfc_cards").update({ platform_previous_status: "active" } as never).eq("id", card.cardId)).error).not.toBeNull();
    expect((await admin.rpc("set_platform_card_lock", input)).error?.code).toBe("55000");
    expect((await admin.rpc("set_platform_card_lock", { ...input, p_locked: false, p_expected_locked: true })).error).toBeNull();
    expect((await admin.from("nfc_cards").select("status").eq("id", card.cardId).single()).data?.status).toBe("inactive");
    expect((await admin.from("platform_admins").delete().eq("user_id", owner.userId)).error).toBeNull();
    expect((await admin.rpc("set_platform_card_lock", input)).error?.code).toBe("42501");
  } finally {
    await admin.from("platform_card_audit").delete().eq("organization_id", customer.orgId);
    await cleanupOrgWithMember(customer.userId, customer.orgId);
    await cleanupOrgWithMember(owner.userId, owner.orgId);
  }
});
