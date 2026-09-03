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
          <EmptyTitle>No locations yet</EmptyTitle>
          <EmptyDescription>
            Add your first location to start issuing NFC cards for it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <LocationDialog
            trigger={<Button size="sm">Add location</Button>}
          />
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Google review</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
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
                <Badge variant="secondary">Configured</Badge>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={location.status === "active" ? "secondary" : "outline"}>
                {location.status === "active" ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell className="flex justify-end gap-2">
              <LocationDialog
                location={location}
                trigger={
                  <Button variant="outline" size="sm">
                    Edit
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
                  {location.status === "active" ? "Deactivate" : "Activate"}
                </Button>
              </form>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
