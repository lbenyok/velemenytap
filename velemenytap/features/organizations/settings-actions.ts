"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
    // Round-6 finding R6-01: this RPC used to return the raw confirmation
    // token directly -- to a function callable by `authenticated`, meaning
    // any org member could obtain a live token for any address by calling
    // the RPC directly (bypassing this Server Action, and Resend,
    // entirely), never proving they control that inbox. It now returns
    // only a log_id (not a secret); the token itself is minted by
    // issue_notification_email_change_token(), granted to `service_role`
    // ONLY -- called here via the admin client, from trusted server code,
    // never reachable from a browser or any authenticated session.
    // Round-5 R5-12's server-owned cooldown/hourly budget is enforced the
    // same way as before, just without caller-suppliable parameters
    // (round-6 R6-04) -- see the migration.
    //
    // Named reserve_notification_email_change, not request_notification_
    // email_change -- a second independent review found the original name
    // collided with production's already-deployed 3-argument function of
    // the same name (identical callable shape once its own default
    // applies), guaranteeing a PGRST203 outage for every caller during any
    // rollout window where both existed. See supabase/migrations/
    // 20260905193325's header comment for the full incident.
    const { data: logId, error: requestError } = await supabase.rpc("reserve_notification_email_change", {
      p_organization_id: organization.id,
      p_email: parsed.data.notification_email,
    });
    if (requestError || logId === null) {
      const tooManyRequests = requestError?.code === "VT203" || requestError?.code === "VT204";
      return {
        error: tooManyRequests
          ? "Túl sok e-mail cím módosítási kérés érkezett. Kérjük, várj egy kicsit, majd próbáld újra."
          : "Nem sikerült elindítani az e-mail cím megerősítését. Kérjük, próbáld újra.",
      };
    }

    // finalize_notification_email_change_send is also service_role-only
    // now (round-6 R6-04) -- a client can no longer report its own
    // reservation as delivered/failed, so both privileged calls use the
    // admin client, never the user's RLS-bound session.
    //
    // Round-7 finding R7-06 (LOW): once request_notification_email_change
    // above has created a 'reserved' row, EVERY path from here on --
    // issue_notification_email_change_token failing, Resend failing, or
    // an unexpected exception anywhere in between -- must still finalize
    // that reservation, or it strands as 'reserved' (permanently
    // consuming its hourly-budget slot until it ages out of the trailing-
    // hour window on its own, per that table's own documented worst case)
    // for a send that never happened. The `try`/`catch`/`finally` here
    // guarantees exactly one finalize attempt regardless of which branch
    // ran or whether anything threw -- `sent` starts false and is only
    // ever set true after a confirmed successful send, so an exception
    // partway through is reported as a failed attempt, never a delivered
    // one.
    const admin = createAdminClient();
    let sent = false;
    let issuanceFailed = false;
    try {
      const { data: token, error: tokenError } = await admin.rpc("issue_notification_email_change_token", {
        p_log_id: logId,
      });
      if (tokenError || !token) {
        issuanceFailed = true;
      } else {
        sent = await sendNotificationEmailConfirmation({
          email: parsed.data.notification_email,
          token,
          organizationName: parsed.data.name,
        });
      }
    } catch (err) {
      console.error("Unexpected error issuing or sending the notification-email confirmation:", err);
      issuanceFailed = true;
    } finally {
      try {
        const { error: finalizeError } = await admin.rpc("finalize_notification_email_change_send", {
          p_log_id: logId,
          p_delivered: sent,
        });
        if (finalizeError) {
          console.error("Failed to finalize a notification-email-change reservation:", finalizeError);
        }
      } catch (err) {
        // A network-level failure to even reach finalize itself -- logged,
        // not retried indefinitely; the reservation still ages out of the
        // trailing-hour budget window on its own (an accepted, bounded
        // worst case, the same one an unfinalized reservation from a
        // crashed process already represents -- see the migration's own
        // comment on private.notification_email_change_log).
        console.error("Unexpected error finalizing a notification-email-change reservation:", err);
      }
    }

    if (issuanceFailed) {
      return {
        error: "Nem sikerült elindítani az e-mail cím megerősítését. Kérjük, próbáld újra.",
      };
    }
    if (!sent) {
      return {
        error:
          "Nem sikerült elküldeni a megerősítő e-mailt. Ellenőrizd az e-mail címet, és próbáld újra.",
      };
    }
    // Deliberate: if the email genuinely sent (`sent === true`) but the
    // finalize call itself failed (logged above), the user still sees
    // success -- the real-world outcome they care about (an email went
    // out) happened; a finalize failure is purely an internal budget-
    // accounting concern, not something that should make a successful
    // send look like a failure to the person who triggered it.
    pendingEmail = parsed.data.notification_email;
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { success: true, pendingEmail };
}
