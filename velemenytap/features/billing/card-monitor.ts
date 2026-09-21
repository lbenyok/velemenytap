import "server-only";
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";

/** Runs after the existing Stripe sweep. Includes expired no-card trials. */
export async function runBillingCardMonitor() {
  const admin = createAdminClient();
  const { data: controls, error } = await admin.from("billing_card_controls")
    .select("organization_id").order("checked_at", { nullsFirst: true }).order("organization_id").limit(100);
  if (error) throw new Error("A kártyák fizetési ellenőrzése nem indítható.");
  let errors = 0;
  for (const control of controls ?? []) {
    const result = await admin.rpc("evaluate_billing_card_control", { p_organization_id: control.organization_id });
    if (result.error) { errors++; console.error("Billing card evaluation failed", control.organization_id, result.error.code); }
  }
  const notices = await sendBillingOwnerNotices();
  return { checked: controls?.length ?? 0, errors: errors + notices.errors, sent: notices.sent };
}

export async function sendBillingOwnerNotices() {
  const admin = createAdminClient();
  const { data: settings, error } = await admin.from("billing_monitor_settings").select("enabled").eq("id", true).single();
  if (error) throw new Error("Az értesítési beállítás nem olvasható.");
  if (!settings.enabled) return { sent: 0, errors: 0 };
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    console.error("Billing owner alerts enabled but email provider is not configured.");
    return { sent: 0, errors: 1 };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  let sent = 0;
  let errors = 0;
  for (let i = 0; i < 20; i++) {
    const { data, error: claimError } = await admin.rpc("claim_billing_owner_notice", { p_sender: process.env.RESEND_FROM_EMAIL });
    if (claimError) { errors++; break; }
    const notice = data?.[0];
    if (!notice) break;
    try {
      const result = await resend.emails.send({
        from: `VéleményTap <${notice.sender}>`,
        to: [notice.recipient],
        subject: "VéleményTap – fizetési és kártyaállapot értesítés",
        text: notice.message,
      }, { idempotencyKey: `billing-owner-notice/${notice.id}` });
      if (result.error || !result.data?.id) throw new Error("Az e-mail-szolgáltató nem igazolta a küldést.");
      const saved = await admin.from("billing_owner_notices").update({
        sent_at: new Date().toISOString(), provider_id: result.data.id, last_error: null,
      }).eq("id", notice.id).eq("lease_owner", notice.lease_owner!).select("id");
      if (saved.error || !saved.data?.length) throw new Error("A küldés eredménye nem rögzíthető.");
      sent++;
    } catch {
      errors++;
      // Keep the lease cooldown; same payload/key on retry, never a new message.
      const saved = await admin.from("billing_owner_notices").update({
        last_error: "A küldés vagy a visszaigazolás sikertelen; automatikus újrapróbálás várható.",
      }).eq("id", notice.id).eq("lease_owner", notice.lease_owner!);
      if (saved.error) console.error("Failed to record billing notification error", notice.id);
    }
  }
  const review = await admin.from("billing_owner_notices").select("id", { count: "exact", head: true }).eq("needs_review", true);
  if (review.error || review.count) errors++;
  return { sent, errors };
}
