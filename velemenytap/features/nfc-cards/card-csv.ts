export type CardCsvRow = {
  display_name: string | null;
  location_name: string;
  status: "active" | "inactive";
  public_id: string;
};

/**
 * The delimiter is a SEMICOLON, not a comma.
 *
 * This file exists to be opened in Excel by a Hungarian user, and Hungarian
 * Windows uses `,` as the decimal separator — so Excel's list separator is `;`
 * and a comma-delimited file lands entirely in column A. Google Sheets and
 * LibreOffice both detect the delimiter, so semicolons cost nothing there.
 */
const DELIMITER = ";";

/**
 * Excel will not read UTF-8 without a byte-order mark: "Kávézó" arrives as
 * "KÃ¡vÃ©zÃ³". Every location and card name in this product is Hungarian, so
 * the BOM is not optional here.
 */
const BOM = "﻿";

/** RFC 4180 quoting: wrap when the value could break the row, and double any quote. */
function field(value: string): string {
  const needsQuoting = /["\r\n]/.test(value) || value.includes(DELIMITER);
  return needsQuoting ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The card list as a spreadsheet, for the one job it has: sitting open beside
 * an NFC writer while someone encodes a batch of physical cards.
 *
 * Sorted by location and then card name rather than by creation date, because
 * cards are encoded in the order they will be placed — all of the terrace, then
 * all of the counter — and the dashboard's newest-first order is the wrong one
 * for that.
 *
 * Inactive cards are included rather than filtered out, with their status in
 * its own column. Silently omitting them would mean a row count that does not
 * match the dashboard, and someone eventually encoding a card that is switched
 * off is a smaller problem than someone wondering where a card went.
 */
export function buildCardCsv(cards: CardCsvRow[], siteUrl: string): string {
  const header = ["Helyszín", "Kártya", "Állapot", "Nyilvános link"];

  const sorted = [...cards].sort((a, b) => {
    const byLocation = a.location_name.localeCompare(b.location_name, "hu");
    if (byLocation !== 0) return byLocation;
    return (a.display_name ?? "").localeCompare(b.display_name ?? "", "hu");
  });

  const rows = sorted.map((card) =>
    [
      card.location_name,
      card.display_name ?? "Névtelen kártya",
      card.status === "active" ? "Aktív" : "Inaktív",
      `${siteUrl}/r/${card.public_id}`,
    ]
      .map(field)
      .join(DELIMITER),
  );

  // CRLF, which is what RFC 4180 specifies and what Excel is happiest with.
  return BOM + [header.join(DELIMITER), ...rows].join("\r\n") + "\r\n";
}

export function cardCsvFilename(today: Date): string {
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  return `velemenytap-nfc-kartyak-${stamp}.csv`;
}
