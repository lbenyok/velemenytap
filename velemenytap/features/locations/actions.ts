"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { safeGoogleReviewUrl } from "@/lib/google-review-url";

export type LocationActionState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const locationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A helyszín neve kötelező.")
    .max(200, "A helyszín neve túl hosszú."),
  address: z
    .string()
    .trim()
    .max(500, "A cím túl hosszú.")
    .transform((v) => (v === "" ? null : v)),
  google_review_url: z
    .string()
    .trim()
    .max(2000, "Az URL túl hosszú.")
    // A bare "starts with http(s)://" check accepted any site at all -- the
    // one link this product exists to send customers to was the least
    // validated field in the form. safeGoogleReviewUrl restricts it to real
    // Google review destinations over HTTPS.
    .refine(
      (v) => v === "" || safeGoogleReviewUrl(v) !== null,
      "Másold ide a Google Cégprofilod HTTPS-értékelési linkjét (például https://g.page/r/.../review). Más weboldal linkje nem használható.",
    )
    .transform((v) => safeGoogleReviewUrl(v)),
});

function parseLocationForm(formData: FormData) {
  return locationSchema.safeParse({
    name: formData.get("name") ?? "",
    address: formData.get("address") ?? "",
    google_review_url: formData.get("google_review_url") ?? "",
  });
}

export async function createLocationAction(
  _prevState: LocationActionState,
  formData: FormData,
): Promise<LocationActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("locations").insert({
    organization_id: organization.id,
    name: parsed.data.name,
    address: parsed.data.address,
    google_review_url: parsed.data.google_review_url,
  });

  if (error) {
    return { error: "Nem sikerült létrehozni a helyszínt. Kérjük, próbáld újra." };
  }

  revalidatePath("/dashboard/locations");
  return { success: true };
}

export async function updateLocationAction(
  _prevState: LocationActionState,
  formData: FormData,
): Promise<LocationActionState> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    return { error: "Nem található szervezet a fiókodhoz." };
  }

  const locationId = Number(formData.get("id"));
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return { error: "Érvénytelen helyszín." };
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("locations")
    .update({
      name: parsed.data.name,
      address: parsed.data.address,
      google_review_url: parsed.data.google_review_url,
    })
    .eq("id", locationId)
    .eq("organization_id", organization.id)
    .select("id")
    .single();

  if (error) {
    return { error: "Nem sikerült frissíteni a helyszínt. Kérjük, próbáld újra." };
  }

  revalidatePath("/dashboard/locations");
  return { success: true };
}

export async function setLocationStatusAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const organization = await getCurrentOrganization();
  if (!organization) return { error: "Nem található szervezet a fiókodhoz." };

  const locationId = Number(formData.get("id"));
  const status = formData.get("status");
  if (
    !Number.isInteger(locationId) ||
    locationId <= 0 ||
    (status !== "active" && status !== "inactive")
  ) {
    return { error: "Érvénytelen helyszín vagy állapot." };
  }

  const supabase = await createClient();
  // Previously this ignored both the error and the affected-row count, so a
  // failed or zero-row update rendered exactly like a successful one. A
  // deactivation that silently did nothing leaves a card collecting feedback
  // the owner believes they switched off.
  const { data, error } = await supabase
    .from("locations")
    .update({ status })
    .eq("id", locationId)
    .eq("organization_id", organization.id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      error:
        "Nem sikerült módosítani a helyszín állapotát. Frissítsd az oldalt, majd próbáld újra.",
    };
  }

  revalidatePath("/dashboard/locations");
  // A location's status gates its cards' public pages, so the card list's
  // own rendering of that state has to be refreshed too.
  revalidatePath("/dashboard/nfc-cards");
  return {};
}
