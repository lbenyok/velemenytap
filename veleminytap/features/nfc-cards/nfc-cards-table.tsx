import Link from "next/link";
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
import { setNfcCardStatusAction } from "./actions";
import { NfcCardDialog } from "./nfc-card-dialog";
import { CopyUrlButton } from "./copy-url-button";
import type { NfcCardFormValues, LocationOption } from "./nfc-card-form";

export type NfcCardRow = NfcCardFormValues & {
  public_id: string;
  status: "active" | "inactive";
  location_name: string;
};

export function NfcCardsTable({
  cards,
  locations,
  siteUrl,
}: {
  cards: NfcCardRow[];
  locations: LocationOption[];
  siteUrl: string;
}) {
  if (locations.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Add a location first</EmptyTitle>
          <EmptyDescription>
            NFC cards belong to a location. Create one, then come back here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            render={<Link href="/dashboard/locations" />}
            nativeButton={false}
          >
            Go to locations
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (cards.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No NFC cards yet</EmptyTitle>
          <EmptyDescription>
            Add a card for a location and print its link to an NFC tag.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <NfcCardDialog
            locations={locations}
            trigger={<Button size="sm">Add NFC card</Button>}
          />
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Card</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Public link</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => {
          const publicUrl = `${siteUrl}/r/${card.public_id}`;
          return (
            <TableRow key={card.id}>
              <TableCell className="font-medium">
                {card.display_name ?? "Untitled card"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {card.location_name}
              </TableCell>
              <TableCell>
                <CopyUrlButton url={publicUrl} />
              </TableCell>
              <TableCell>
                <Badge variant={card.status === "active" ? "secondary" : "outline"}>
                  {card.status === "active" ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell className="flex justify-end gap-2">
                <NfcCardDialog
                  card={card}
                  locations={locations}
                  trigger={
                    <Button variant="outline" size="sm">
                      Edit
                    </Button>
                  }
                />
                <form action={setNfcCardStatusAction}>
                  <input type="hidden" name="id" value={card.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={card.status === "active" ? "inactive" : "active"}
                  />
                  <Button type="submit" variant="ghost" size="sm">
                    {card.status === "active" ? "Deactivate" : "Activate"}
                  </Button>
                </form>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
