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
import { StatusToggleForm } from "@/components/status-toggle-form";
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
          <EmptyTitle>Adj hozzá először egy helyszínt</EmptyTitle>
          <EmptyDescription>
            Az NFC kártyák egy helyszínhez tartoznak. Hozz létre egyet, majd
            gyere vissza ide.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            render={<Link href="/dashboard/locations" />}
            nativeButton={false}
          >
            Ugrás a helyszínekhez
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (cards.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Még nincs NFC kártya</EmptyTitle>
          <EmptyDescription>
            Adj hozzá egy kártyát egy helyszínhez. A létrejövő linket írd az
            NFC-kártyára egy NFC-író alkalmazással, majd próbáld ki a telefonoddal.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <NfcCardDialog
            locations={locations}
            trigger={<Button size="sm">NFC kártya hozzáadása</Button>}
          />
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Kártya</TableHead>
          <TableHead>Helyszín</TableHead>
          <TableHead>Nyilvános link</TableHead>
          <TableHead>Állapot</TableHead>
          <TableHead className="text-right">Műveletek</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => {
          const publicUrl = `${siteUrl}/r/${card.public_id}`;
          return (
            <TableRow key={card.id}>
              <TableCell className="font-medium">
                {card.display_name ?? "Névtelen kártya"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {card.location_name}
              </TableCell>
              <TableCell>
                <CopyUrlButton url={publicUrl} />
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-3 inline-block text-sm underline underline-offset-4"
                >
                  Kipróbálás
                </a>
              </TableCell>
              <TableCell>
                <Badge variant={card.status === "active" ? "secondary" : "outline"}>
                  {card.status === "active" ? "Aktív" : "Inaktív"}
                </Badge>
              </TableCell>
              <TableCell className="flex justify-end gap-2">
                <NfcCardDialog
                  card={card}
                  locations={locations}
                  trigger={
                    <Button variant="outline" size="sm">
                      Szerkesztés
                    </Button>
                  }
                />
                <StatusToggleForm
                  id={card.id}
                  status={card.status}
                  action={setNfcCardStatusAction}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
