"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPlatformAdmin } from "./access";

const requestSchema = z.object({
  cardId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  locked: z.enum(["true", "false"]),
  expected: z.enum(["true", "false"]),
  reason: z.string().trim().min(2).max(500),
});

export async function setPlatformCardLockAction(
  _previous: { error?: string; success?: boolean }, formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  // Authorization always precedes any service-role data access.
  const actor = await getPlatformAdmin();
  if (!actor) return { error: "Nincs platform-adminisztrátori jogosultságod." };
  const parsed = requestSchema.safeParse({
    cardId: formData.get("cardId"), locked: formData.get("locked"),
    expected: formData.get("expected"), reason: formData.get("reason"),
  });
  if (!parsed.success) return { error: "Válassz érvényes kártyát, és adj meg 2–500 karakteres indoklást." };
  const input = parsed.data;
  const { error } = await createAdminClient().rpc("set_platform_card_lock", {
    p_actor_id: actor.id, p_card_id: input.cardId, p_locked: input.locked === "true",
    p_expected_locked: input.expected === "true", p_reason: input.reason,
  });
  if (error) return { error: "Nem sikerült módosítani a zárolást. Frissítsd az oldalt, és ellenőrizd a kártya állapotát." };
  revalidatePath("/admin");
  revalidatePath("/dashboard/nfc-cards");
  return { success: true };
}
