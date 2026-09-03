import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { LocationDialog } from "@/features/locations/location-dialog";
import { LocationsTable, type LocationRow } from "@/features/locations/locations-table";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Locations — VéleményTap" };

export default async function LocationsPage() {
  const organization = await getCurrentOrganization();
  const supabase = await createClient();

  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, address, google_review_url, status")
    .eq("organization_id", organization?.id ?? 0)
    .order("name", { ascending: true });

  const rows: LocationRow[] = locations ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Locations</h1>
          <p className="text-sm text-muted-foreground">
            Manage the physical locations customers give feedback about.
          </p>
        </div>
        {rows.length > 0 ? (
          <LocationDialog trigger={<Button>Add location</Button>} />
        ) : null}
      </div>
      <LocationsTable locations={rows} />
    </div>
  );
}
