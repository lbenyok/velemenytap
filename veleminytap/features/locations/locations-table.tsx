import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { setLocationStatusAction } from "./actions";
import { LocationDialog } from "./location-dialog";
import type { LocationFormValues } from "./location-form";

export type LocationRow = LocationFormValues & {
  status: "active" | "inactive";
};

export function LocationsTable({ locations }: { locations: LocationRow[] }) {
  if (locations.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Még nincs helyszín</EmptyTitle>
          <EmptyDescription>
            Add hozzá az első helyszínt, hogy NFC-kártyákat készíthess hozzá.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <LocationDialog
            trigger={<Button size="sm">Helyszín hozzáadása</Button>}
          />
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Név</TableHead>
          <TableHead>Cím</TableHead>
          <TableHead>Google-értékelés</TableHead>
          <TableHead>Állapot</TableHead>
          <TableHead className="text-right">Műveletek</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {locations.map((location) => (
          <TableRow key={location.id}>
            <TableCell className="font-medium">{location.name}</TableCell>
            <TableCell className="text-muted-foreground">
              {location.address ?? "—"}
            </TableCell>
            <TableCell>
              {location.google_review_url ? (
                <Badge variant="secondary">Beállítva</Badge>
              ) : (
                <span className="text-muted-foreground">Nincs beállítva</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={location.status === "active" ? "secondary" : "outline"}>
                {location.status === "active" ? "Aktív" : "Inaktív"}
              </Badge>
            </TableCell>
            <TableCell className="flex justify-end gap-2">
              <LocationDialog
                location={location}
                trigger={
                  <Button variant="outline" size="sm">
                    Szerkesztés
                  </Button>
                }
              />
              <form action={setLocationStatusAction}>
                <input type="hidden" name="id" value={location.id} />
                <input
                  type="hidden"
                  name="status"
                  value={location.status === "active" ? "inactive" : "active"}
                />
                <Button type="submit" variant="ghost" size="sm">
                  {location.status === "active" ? "Deaktiválás" : "Aktiválás"}
                </Button>
              </form>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
