"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type SettingsActionState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const settingsSchema = z.object({
  name: z.string().trim().min(2, "Business name must be at least 2 characters.").max(100),
  notification_email: z
    .string()
    .trim()
    .max(255)
    .refine(
      (v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
      "Enter a valid email address.",
    )
    .transform((v) => (v === "" ? null : v)),
  logo_url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "Enter a valid URL starting with http:// or https://")
    .transform((v) => (v === "" ? null : v)),
});

export async function updateOrganizationSettingsAction(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "No organization found for your account." };
  }

  const parsed = settingsSchema.safeParse({
    name: formData.get("name"),
    notification_email: formData.get("notification_email") ?? "",
    logo_url: formData.get("logo_url") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({
      name: parsed.data.name,
      notification_email: parsed.data.notification_email,
      logo_url: parsed.data.logo_url,
    })
    .eq("id", organization.id);

  if (error) {
    return { error: "Could not save settings. Please try again." };
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { success: true };
}
