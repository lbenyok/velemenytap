"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildCardCsv, cardCsvFilename, type CardCsvRow } from "./card-csv";

/**
 * Downloads every card's public link as a spreadsheet.
 *
 * Deliberately client-side, from data the page has already loaded and already
 * rendered. A `/api/cards.csv` route would be the obvious alternative and would
 * mean a new authenticated endpoint returning one tenant's data — a new place
 * to get authorization wrong, in a codebase where that has repeatedly been the
 * defect. This adds no surface at all: if you can see the table, you can save
 * the table.
 *
 * The job it exists for is encoding physical cards. Copying twenty URLs one
 * button at a time is not just slow, it is how a card ends up carrying the
 * wrong location's link — a mistake that is invisible once the card is written
 * and permanent once it is locked.
 */
export function ExportCsvButton({ cards, siteUrl }: { cards: CardCsvRow[]; siteUrl: string }) {
  const [failed, setFailed] = useState(false);

  if (cards.length === 0) return null;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          try {
            const csv = buildCardCsv(cards, siteUrl);
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
            const href = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = href;
            link.download = cardCsvFilename(new Date());
            document.body.appendChild(link);
            link.click();
            link.remove();
            // Revoking immediately can cancel the download in some browsers;
            // a tick later is safely after it has started.
            setTimeout(() => URL.revokeObjectURL(href), 1000);
            setFailed(false);
          } catch {
            // Same reasoning as CopyUrlButton's clipboard fallback: a button
            // that quietly does nothing leaves someone with no way to get the
            // links onto an NFC writer, and no idea why.
            setFailed(true);
          }
        }}
      >
        <Download data-icon="inline-start" />
        Linkek letöltése (CSV)
      </Button>
      {failed ? (
        <p role="status" className="max-w-xs text-xs whitespace-normal">
          A letöltést a böngésző nem engedélyezte. Másold ki a linkeket
          egyesével a táblázatból.
        </p>
      ) : null}
    </div>
  );
}
