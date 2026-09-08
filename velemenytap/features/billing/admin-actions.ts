"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";
import { canManageBilling } from "@/features/billing/status";
import { reconcileOrganizationBilling } from "@/features/billing/reconcile";

/**
 * Fourth independent review, Finding 5: the "authenticated administrator
 * repair path" -- an owner/admin can trigger reconciliation for their OWN
 * organization directly from the billing page, rather than being stuck
 * waiting for a webhook that may never arrive. Goes through the exact
 * same shared reconcileOrganizationBilling service as the webhook, the
 * checkout-success page, and the scheduled sweep -- there is no separate,
 * bespoke "manual fix" code path that could drift from what the other
 * three do.
 */
export type ResyncState = { status: "idle" } | { status: "success"; message: string } | { status: "error"; message: string };

export async function resyncOrganizationBillingAction(): Promise<ResyncState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { status: "error", message: "Nem található szervezet." };
  }
  if (!canManageBilling(organization.role)) {
    return { status: "error", message: "Ehhez tulajdonosi vagy admin szerepkör szükséges." };
  }

  const admin = createAdminClient();
  const { data: billing, error: readError } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organization.id)
    .maybeSingle();

  if (readError || !billing) {
    return { status: "error", message: "Nem sikerült beolvasni a számlázási adatokat." };
  }
  if (!billing.stripe_customer_id) {
    return { status: "error", message: "Ehhez a szervezethez még nem tartozik Stripe ügyfél." };
  }

  const result = await reconcileOrganizationBilling(organization.id, billing.stripe_customer_id);
  revalidatePath("/dashboard/billing");

  if (result.outcome === "reconciled") {
    return { status: "success", message: "Sikeresen frissítve a Stripe aktuális állapota alapján." };
  }
  if (result.outcome === "deferred") {
    return { status: "error", message: "Egy másik frissítés éppen folyamatban van -- próbáld újra egy pillanat múlva." };
  }
  if (result.outcome === "no_subscriptions") {
    return { status: "error", message: "A Stripe nem talált ehhez a szervezethez tartozó előfizetést." };
  }
  return { status: "error", message: "Nem sikerült frissíteni. Kérjük, próbáld újra." };
}

/**
 * A plain <form action={...}> can't accept an action returning a value --
 * this thin wrapper is what the billing page's own resync button actually
 * uses; the page's own revalidatePath (inside resyncOrganizationBillingAction
 * itself) is what makes the result visible, not a returned message.
 */
export async function resyncOrganizationBillingFormAction(): Promise<void> {
  await resyncOrganizationBillingAction();
}
