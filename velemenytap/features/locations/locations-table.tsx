import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { StatusToggleForm } from "@/components/status-toggle-form";
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
                // Not a muted "—" like the address column above it. A
                // location with no Google destination still collects
                // feedback perfectly well, so nothing anywhere else looks
                // wrong -- while every customer who taps a card here reaches
                // a dead end instead of the review the product exists to
                // produce. The icon carries the same meaning as the colour,
                // so this does not depend on colour alone.
                <Badge variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  Nincs beállítva
                </Badge>
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
              <StatusToggleForm
                id={location.id}
                status={location.status}
                action={setLocationStatusAction}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
