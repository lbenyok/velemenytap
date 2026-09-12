import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { LocationDialog } from "@/features/locations/location-dialog";
import { LocationsTable, type LocationRow } from "@/features/locations/locations-table";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TriangleAlert } from "lucide-react";

export const metadata: Metadata = { title: "Helyszínek — VéleményTap" };

export default async function LocationsPage() {
  const organization = await getCurrentOrganization();
  const supabase = await createClient();

  const { data: locations, error } = await supabase
    .from("locations")
    .select("id, name, address, google_review_url, status")
    .eq("organization_id", organization?.id ?? 0)
    .order("name", { ascending: true });

  // Without this, a read failure renders the "no locations yet" empty state
  // to an owner who has locations -- and invites them to create duplicates.
  if (error) throw new Error("Nem sikerült betölteni a helyszíneket.");

  const rows: LocationRow[] = locations ?? [];

  // An active location with no Google destination is the one misconfiguration
  // that disables what this product is for while leaving every other signal
  // looking healthy: cards still work, feedback still arrives, the dashboard
  // still fills up -- and not one customer is ever offered the Google review.
  // Inactive locations are excluded deliberately: they aren't collecting
  // anything, so there is nothing to warn about.
  const missingReviewUrl = rows.filter(
    (location) => location.status === "active" && !location.google_review_url,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            Helyszínek
          </h1>
          <p className="text-sm text-muted-foreground">
            Kezeld azokat a fizikai helyszíneket, amelyekről a vásárlók
            véleményt adnak.
          </p>
        </div>
        {rows.length > 0 ? (
          <LocationDialog trigger={<Button>Helyszín hozzáadása</Button>} />
        ) : null}
      </div>
      {missingReviewUrl.length > 0 ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>
            {missingReviewUrl.length === 1
              ? "Egy aktív helyszínhez nincs Google-értékelési link"
              : `${missingReviewUrl.length} aktív helyszínhez nincs Google-értékelési link`}
          </AlertTitle>
          <AlertDescription>
            {missingReviewUrl.map((location) => location.name).join(", ")} — a
            vendégek véleménye ide beérkezik, de a Google-értékelés gombot nem
            látják. Szerkeszd a helyszínt, és másold be a Google Cégprofil
            értékelési linkjét.
          </AlertDescription>
        </Alert>
      ) : null}
      <LocationsTable locations={rows} />
    </div>
  );
}
