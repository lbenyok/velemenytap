import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { NfcCardDialog } from "@/features/nfc-cards/nfc-card-dialog";
import { NfcCardsTable, type NfcCardRow } from "@/features/nfc-cards/nfc-cards-table";
import type { LocationOption } from "@/features/nfc-cards/nfc-card-form";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "NFC Cards — VéleményTap" };

export default async function NfcCardsPage() {
  const organization = await getCurrentOrganization();
  const supabase = await createClient();
  const orgId = organization?.id ?? 0;

  const [{ data: locations }, { data: cards }] = await Promise.all([
    supabase
      .from("locations")
      .select("id, name")
      .eq("organization_id", orgId)
      .order("name", { ascending: true }),
    supabase
      .from("nfc_cards")
      .select("id, display_name, location_id, status, public_id, locations(name)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false }),
  ]);

  const locationOptions: LocationOption[] = (locations ?? []).map((l) => ({
    value: String(l.id),
    label: l.name,
  }));

  const rows: NfcCardRow[] = (cards ?? []).map((c) => ({
    id: c.id,
    display_name: c.display_name,
    location_id: c.location_id,
    status: c.status,
    public_id: c.public_id,
    location_name: c.locations?.name ?? "—",
  }));

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">NFC Cards</h1>
          <p className="text-sm text-muted-foreground">
            Each card gets a unique link customers tap into to leave feedback.
          </p>
        </div>
        {rows.length > 0 ? (
          <NfcCardDialog
            locations={locationOptions}
            trigger={<Button>Add NFC card</Button>}
          />
        ) : null}
      </div>
      <NfcCardsTable cards={rows} locations={locationOptions} siteUrl={siteUrl} />
    </div>
  );
}
