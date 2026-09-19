import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, seedActiveCard, userClient } from "./support/seed";
import { signInViaUi } from "./support/ui";

test("dashboard deactivation blocks an already-open form, preserves history and URL, and reactivation restores submissions", async ({ page, context }) => {
  test.setTimeout(120_000);
  const member = await seedOrgWithMember("remote-card");
  try {
    const card = await seedActiveCard(member.orgId, "remote-card");
    const admin = adminClient();
    const prior = await admin.rpc("submit_feedback_atomic", {
      p_public_id: card.publicId, p_rating: 2, p_feedback_text: "Preserve this feedback",
    }).single();
    expect(prior.error).toBeNull();
    const visitor = await context.newPage();
    await visitor.goto(`/r/${card.publicId}`);
    await visitor.getByRole("radio", { name: /^3 csillag —/ }).click();
    await signInViaUi(page, member.email, member.password, "/dashboard/nfc-cards");
    const row = page.getByRole("row").filter({ hasText: "E2E Card" });
    await row.getByRole("button", { name: "Deaktiválás", exact: true }).click();
    await expect(row.getByText("Inaktív", { exact: true })).toBeVisible();
    await visitor.getByRole("button", { name: "Vélemény küldése" }).click();
    await expect(visitor.locator('p[role="alert"]')).toHaveText("Ez a link már nem aktív.");
    const rejected = await admin.rpc("submit_feedback_atomic", { p_public_id: card.publicId, p_rating: 5, p_feedback_text: null });
    expect(rejected.error?.code).toBe("VT002");
    await visitor.reload();
    await expect(visitor.getByText("Ez a VéleményTap kártya jelenleg nem aktív.", { exact: true })).toBeVisible();
    await expect(visitor.getByRole("radiogroup")).toHaveCount(0);
    await expect(visitor.getByText(/E2E remote-card/)).toHaveCount(0);
    const history = await admin.from("feedback").select("id, feedback_text").eq("nfc_card_id", card.cardId);
    expect(history.error).toBeNull();
    expect(history.data).toEqual([{ id: prior.data!.feedback_id, feedback_text: "Preserve this feedback" }]);
    await row.getByRole("button", { name: "Aktiválás", exact: true }).click();
    await expect(row.getByText("Aktív", { exact: true })).toBeVisible();
    const stored = await admin.from("nfc_cards").select("public_id, status").eq("id", card.cardId).single();
    expect(stored.error).toBeNull();
    expect(stored.data).toEqual({ public_id: card.publicId, status: "active" });
    await visitor.reload();
    await visitor.getByRole("radio", { name: /^3 csillag —/ }).click();
    await visitor.getByRole("button", { name: "Vélemény küldése" }).click();
    await expect(visitor.getByRole("heading", { name: "Köszönjük!" })).toBeVisible();
    await visitor.goto(`/r/${randomUUID()}`);
    await expect(visitor.getByRole("heading", { name: "Ez a link nem működik" })).toBeVisible();
  } finally {
    await cleanupOrgWithMember(member.userId, member.orgId);
  }
});

test("RLS rejects another tenant and anonymous mutations in both directions, and public RPC access", async () => {
  const a = await seedOrgWithMember("card-tenant-a");
  const b = await seedOrgWithMember("card-tenant-b");
  try {
    const card = await seedActiveCard(b.orgId, "card-tenant-b");
    const attacker = await userClient(a.email, a.password);
    const owner = await userClient(b.email, b.password);
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    for (const status of ["inactive", "active"] as const) {
      const before = status === "active" ? "inactive" : "active";
      for (const caller of [attacker, anon]) {
        const denied = await caller.from("nfc_cards").update({ status }).eq("id", card.cardId).select("id");
        expect(denied.data ?? []).toEqual([]);
        const current = await adminClient().from("nfc_cards").select("status").eq("id", card.cardId).single();
        expect(current.error).toBeNull();
        expect(current.data?.status).toBe(before);
        const direct = await caller.rpc("submit_feedback_atomic", { p_public_id: card.publicId, p_rating: 5, p_feedback_text: null });
        expect(direct.error).not.toBeNull();
      }
      const allowed = await owner.from("nfc_cards").update({ status }).eq("id", card.cardId).select("status").single();
      expect(allowed.error).toBeNull();
      expect(allowed.data?.status).toBe(status);
    }
  } finally {
    await cleanupOrgWithMember(a.userId, a.orgId);
    await cleanupOrgWithMember(b.userId, b.orgId);
  }
});
