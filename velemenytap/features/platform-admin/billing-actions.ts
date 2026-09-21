"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getPlatformAdmin } from "./access";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileOrganizationBilling } from "@/features/billing/reconcile";

type Result = { error?: string; success?: string };
const schema = z.object({
  organizationId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["manual", "automatic"]),
  graceDays: z.coerce.number().int().min(0).max(30),
  revision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export async function saveBillingCardModeAction(_: Result, form: FormData): Promise<Result> {
  const actor = await getPlatformAdmin();
  if (!actor) return { error: "Nincs tulajdonosi jogosultságod." };
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Ellenőrizd a módot és a türelmi időt (0–30 nap)." };
  const v = parsed.data;
  const { error } = await createAdminClient().rpc("set_billing_card_mode", {
    p_actor_id: actor.id, p_organization_id: v.organizationId, p_mode: v.mode,
    p_grace_days: v.graceDays, p_expected_revision: v.revision,
  });
  if (error) return { error: "Nem sikerült menteni. Frissítsd az oldalt és ellenőrizd az állapotot." };
  revalidatePath("/admin");
  return { success: "Beállítás mentve. A kézi kártyazárolások változatlanul érvényesek." };
}
export async function saveBillingAlertSettingsAction(_: Result, form: FormData): Promise<Result> {
  const actor = await getPlatformAdmin();
  if (!actor?.email) return { error: "Nincs megerősített tulajdonosi fiókod." };
  const enabled = form.get("enabled") === "on";
  const { error } = await createAdminClient().from("billing_monitor_settings").update({
    enabled, recipient: actor.email, updated_by: actor.id, updated_at: new Date().toISOString(),
  }).eq("id", true);
  if (error) return { error: "Az értesítési beállítás nem menthető." };
  revalidatePath("/admin");
  return { success: enabled ? "Az értesítéseket a saját megerősített e-mail-címedre küldjük." : "A fizetési értesítések kikapcsolva." };
}
export async function checkBillingNowAction(_: Result, form: FormData): Promise<Result> {
  const actor = await getPlatformAdmin();
  if (!actor) return { error: "Nincs tulajdonosi jogosultságod." };
  const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(form.get("organizationId"));
  if (!id.success) return { error: "Érvénytelen vállalkozás." };
  const admin = createAdminClient();
  const { data, error } = await admin.from("organization_billing").select("stripe_customer_id").eq("organization_id", id.data).single();
  if (error) return { error: "A fizetési adatok nem olvashatók." };
  if (data.stripe_customer_id) {
    const outcome = await reconcileOrganizationBilling(id.data, data.stripe_customer_id);
    if (outcome.outcome === "error" || outcome.outcome === "deferred")
      return { error: "A Stripe-ellenőrzés még nem fejeződött be. Próbáld újra később; ebből nem állapítunk meg új tiltást." };
  }
  const result = await admin.rpc("evaluate_billing_card_control", { p_organization_id: id.data });
  if (result.error) return { error: "A kártyaállapot ellenőrzése sikertelen." };
  revalidatePath("/admin");
  return { success: "Ellenőrzés kész. Az esetleges értesítést az ütemezett feldolgozó küldi el." };
}
