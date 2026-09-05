import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { OrganizationBilling } from "./status";

export async function getOrganizationBilling(
  organizationId: number,
): Promise<OrganizationBilling | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("organization_billing")
    .select("status, trial_ends_at, current_period_end, cancel_at_period_end, stripe_subscription_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  return data;
}
