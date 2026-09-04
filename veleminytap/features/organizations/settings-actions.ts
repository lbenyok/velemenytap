"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { sendNotificationEmailConfirmation } from "@/features/organizations/notification-email-verification";

export type SettingsActionState =
  | { error: string; success?: undefined; pendingEmail?: undefined }
  | { error?: undefined; success: true; pendingEmail?: string }
  | { error?: undefined; success?: undefined; pendingEmail?: undefined };

const settingsSchema = z.object({
  name: z.string().trim().min(2, "A vállalkozás nevének legalább 2 karakter hosszúnak kell lennie.").max(100),
  notification_email: z
    .string()
    .trim()
    .max(255)
    .refine(
      (v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
      "Adj meg egy érvényes e-mail címet.",
    )
    .transform((v) => (v === "" ? null : v)),
  logo_url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "Adj meg egy érvényes URL-t, amely http://-vel vagy https://-vel kezdődik.")
    .transform((v) => (v === "" ? null : v)),
});

export async function updateOrganizationSettingsAction(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const parsed = settingsSchema.safeParse({
    name: formData.get("name"),
    notification_email: formData.get("notification_email") ?? "",
    logo_url: formData.get("logo_url") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();

  const { data: current } = await supabase
    .from("organizations")
    .select("notification_email")
    .eq("id", organization.id)
    .single();

  const { error } = await supabase
    .from("organizations")
    .update({
      name: parsed.data.name,
      logo_url: parsed.data.logo_url,
    })
    .eq("id", organization.id);

  if (error) {
    return { error: "Nem sikerült menteni a beállításokat. Kérjük, próbáld újra." };
  }

  // The notification email is handled separately from the plain UPDATE
  // above -- round-3 finding R3-03: a new address must be verified before
  // it becomes the active one, not written directly. Removing it needs no
  // verification (see clear_notification_email's migration comment).
  let pendingEmail: string | undefined;
  if (parsed.data.notification_email === null) {
    if (current?.notification_email !== null) {
      const { error: clearError } = await supabase.rpc("clear_notification_email", {
        p_organization_id: organization.id,
      });
      if (clearError) {
        return { error: "Nem sikerült törölni az értesítési e-mail címet. Kérjük, próbáld újra." };
      }
    }
  } else if (parsed.data.notification_email !== current?.notification_email) {
    const { data: token, error: requestError } = await supabase.rpc("request_notification_email_change", {
      p_organization_id: organization.id,
      p_email: parsed.data.notification_email,
    });
    if (requestError || !token) {
      return { error: "Nem sikerült elindítani az e-mail cím megerősítését. Kérjük, próbáld újra." };
    }

    const sent = await sendNotificationEmailConfirmation({
      email: parsed.data.notification_email,
      token,
      organizationName: parsed.data.name,
    });
    if (!sent) {
      return {
        error:
          "Nem sikerült elküldeni a megerősítő e-mailt. Ellenőrizd az e-mail címet, és próbáld újra.",
      };
    }
    pendingEmail = parsed.data.notification_email;
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { success: true, pendingEmail };
}
