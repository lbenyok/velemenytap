"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";

export type LocationActionState =
  | { error: string; success?: undefined }
  | { error?: undefined; success: true }
  | { error?: undefined; success?: undefined };

const locationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Location name is required.")
    .max(200, "Location name is too long."),
  address: z
    .string()
    .trim()
    .max(500, "Address is too long.")
    .transform((v) => (v === "" ? null : v)),
  google_review_url: z
    .string()
    .trim()
    .max(2000, "URL is too long.")
    .refine(
      (v) => v === "" || /^https?:\/\//i.test(v),
      "Enter a valid URL starting with http:// or https://",
    )
    .transform((v) => (v === "" ? null : v)),
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
    return { error: "No organization found for your account." };
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("locations").insert({
    organization_id: organization.id,
    name: parsed.data.name,
    address: parsed.data.address,
    google_review_url: parsed.data.google_review_url,
  });

  if (error) {
    return { error: "Could not create the location. Please try again." };
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
    return { error: "No organization found for your account." };
  }

  const locationId = Number(formData.get("id"));
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return { error: "Invalid location." };
  }

  const parsed = parseLocationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
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
    return { error: "Could not update the location. Please try again." };
  }

  revalidatePath("/dashboard/locations");
  return { success: true };
}

export async function setLocationStatusAction(formData: FormData) {
  const organization = await getCurrentOrganization();
  if (!organization) return;

  const locationId = Number(formData.get("id"));
  const status = formData.get("status");
  if (
    !Number.isInteger(locationId) ||
    locationId <= 0 ||
    (status !== "active" && status !== "inactive")
  ) {
    return;
  }

  const supabase = await createClient();
  await supabase
    .from("locations")
    .update({ status })
    .eq("id", locationId)
    .eq("organization_id", organization.id);

  revalidatePath("/dashboard/locations");
}
