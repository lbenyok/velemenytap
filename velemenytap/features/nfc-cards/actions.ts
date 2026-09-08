"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type NfcCardActionState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const displayNameSchema = z
  .string()
  .trim()
  .max(100, "A név túl hosszú.")
  .transform((v) => (v === "" ? null : v));

const createNfcCardSchema = z.object({
  display_name: displayNameSchema,
  location_id: z.coerce
    .number()
    .int()
    .positive("Válassz egy helyszínt."),
});

// No location_id here at all (round-2 finding R2-09): a card's location is
// immutable at the database level once created
// (private.prevent_nfc_card_location_change), so this isn't just "not
// shown in the edit form" -- the server action never even looks for a
// location_id input, let alone attempts to write one. A crafted request
// with an extra location_id field is silently ignored, not rejected with a
// confusing "couldn't save" once it hits the database's own trigger.
const updateNfcCardSchema = z.object({
  display_name: displayNameSchema,
});

/**
 * Confirms the given location actually belongs to this organization before
 * we insert/update a card against it. The database also enforces this (a
 * trigger rejects an nfc_card whose organization_id doesn't match its
 * location's), so this is a friendlier error message on top of that
 * guarantee, not the only thing standing between orgs.
 */
async function locationBelongsToOrg(locationId: number, organizationId: number) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("locations")
    .select("id")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return !!data;
}

export async function createNfcCardAction(
  _prevState: NfcCardActionState,
  formData: FormData,
): Promise<NfcCardActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const parsed = createNfcCardSchema.safeParse({
    display_name: formData.get("display_name") ?? "",
    location_id: formData.get("location_id"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  if (!(await locationBelongsToOrg(parsed.data.location_id, organization.id))) {
    return { error: "Válassz egy érvényes helyszínt." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("nfc_cards").insert({
    organization_id: organization.id,
    location_id: parsed.data.location_id,
    display_name: parsed.data.display_name,
  });

  if (error) {
    return { error: "Nem sikerült létrehozni a kártyát. Kérjük, próbáld újra." };
  }

  revalidatePath("/dashboard/nfc-cards");
  return { success: true };
}

export async function updateNfcCardAction(
  _prevState: NfcCardActionState,
  formData: FormData,
): Promise<NfcCardActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const cardId = Number(formData.get("id"));
  if (!Number.isInteger(cardId) || cardId <= 0) {
    return { error: "Érvénytelen kártya." };
  }

  const parsed = updateNfcCardSchema.safeParse({
    display_name: formData.get("display_name") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("nfc_cards")
    .update({
      display_name: parsed.data.display_name,
    })
    .eq("id", cardId)
    .eq("organization_id", organization.id)
    .select("id")
    .single();

  if (error) {
    return { error: "Nem sikerült frissíteni a kártyát. Kérjük, próbáld újra." };
  }

  revalidatePath("/dashboard/nfc-cards");
  return { success: true };
}

export async function setNfcCardStatusAction(formData: FormData) {
  const organization = await getCurrentOrganization();
  if (!organization) return;

  const cardId = Number(formData.get("id"));
  const status = formData.get("status");
  if (
    !Number.isInteger(cardId) ||
    cardId <= 0 ||
    (status !== "active" && status !== "inactive")
  ) {
    return;
  }

  const supabase = await createClient();
  await supabase
    .from("nfc_cards")
    .update({ status })
    .eq("id", cardId)
    .eq("organization_id", organization.id);

  revalidatePath("/dashboard/nfc-cards");
}
