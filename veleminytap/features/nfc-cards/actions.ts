"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type NfcCardActionState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const nfcCardSchema = z.object({
  display_name: z
    .string()
    .trim()
    .max(100, "A név túl hosszú.")
    .transform((v) => (v === "" ? null : v)),
  location_id: z.coerce
    .number()
    .int()
    .positive("Válassz egy helyszínt."),
});

function parseNfcCardForm(formData: FormData) {
  return nfcCardSchema.safeParse({
    display_name: formData.get("display_name") ?? "",
    location_id: formData.get("location_id"),
  });
}

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

  const parsed = parseNfcCardForm(formData);
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

  const parsed = parseNfcCardForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  if (!(await locationBelongsToOrg(parsed.data.location_id, organization.id))) {
    return { error: "Válassz egy érvényes helyszínt." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("nfc_cards")
    .update({
      display_name: parsed.data.display_name,
      location_id: parsed.data.location_id,
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
