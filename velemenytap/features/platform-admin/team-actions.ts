"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getPlatformAdmin } from "./access";
import { createAdminClient } from "@/lib/supabase/admin";

export async function setModeratorAction(_: { error?: string; success?: string }, form: FormData): Promise<{ error?: string; success?: string }> {
  const actor = await getPlatformAdmin();
  if (!actor || actor.platformRole !== "owner") return { error: "Csak a tulajdonos kezelheti a csapatot." };
  const parsed = z.object({ email: z.string().trim().email().max(320), enabled: z.enum(["true", "false"]) })
    .safeParse({ email: form.get("email"), enabled: form.get("enabled") });
  if (!parsed.success) return { error: "Adj meg érvényes e-mail-címet." };
  const { error } = await createAdminClient().rpc("set_platform_moderator", {
    p_actor_id: actor.id, p_email: parsed.data.email, p_enabled: parsed.data.enabled === "true",
  });
  if (error) return { error: error.code === "P0002"
    ? "Ezen a címen nincs megerősített fiók. Előbb regisztráljon, és erősítse meg az e-mail-címét."
    : "A jogosultság nem módosítható. Tulajdonosi hozzáférés itt nem változtatható meg." };
  revalidatePath("/admin");
  return { success: parsed.data.enabled === "true" ? "A moderátori hozzáférés beállítva." : "A moderátori hozzáférés visszavonva." };
}
