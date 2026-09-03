"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type UpdateFeedbackState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const updateSchema = z.object({
  id: z.coerce.number().int().positive(),
  status: z.enum(["new", "in_progress", "resolved"]),
  internal_note: z
    .string()
    .trim()
    .max(5000, "A megjegyzés túl hosszú.")
    .transform((v) => (v === "" ? null : v)),
});

export async function updateFeedbackAction(
  _prevState: UpdateFeedbackState,
  formData: FormData,
): Promise<UpdateFeedbackState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const parsed = updateSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
    internal_note: formData.get("internal_note") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("feedback")
    .update({ status: parsed.data.status, internal_note: parsed.data.internal_note })
    .eq("id", parsed.data.id)
    .eq("organization_id", organization.id)
    .select("id")
    .single();

  if (error) {
    return { error: "Nem sikerült menteni. Kérjük, próbáld újra." };
  }

  revalidatePath("/dashboard/feedback");
  return { success: true };
}
