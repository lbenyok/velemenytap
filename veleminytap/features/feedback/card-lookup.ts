import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type PublicCardInfo = {
  cardId: number;
  organizationId: number;
  locationId: number;
  organizationName: string;
  locationName: string;
  googleReviewUrl: string | null;
  isActive: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a scanned NFC card's public_id to its organization/location,
 * for both rendering the public landing page and validating a feedback
 * submission. Runs as an unauthenticated visitor (no session, no org
 * membership), so this uses the admin client rather than an RLS policy --
 * there is deliberately no anon SELECT policy on nfc_cards/locations/
 * organizations (see the schema migration's RLS notes).
 */
export async function lookupPublicCard(
  publicId: string,
): Promise<PublicCardInfo | null> {
  if (!UUID_RE.test(publicId)) {
    return null;
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("nfc_cards")
    .select(
      "id, organization_id, location_id, status, organizations(name), locations(name, status, google_review_url)",
    )
    .eq("public_id", publicId)
    .maybeSingle();

  if (!data || !data.organizations || !data.locations) {
    return null;
  }

  return {
    cardId: data.id,
    organizationId: data.organization_id,
    locationId: data.location_id,
    organizationName: data.organizations.name,
    locationName: data.locations.name,
    googleReviewUrl: data.locations.google_review_url,
    isActive: data.status === "active" && data.locations.status === "active",
  };
}
