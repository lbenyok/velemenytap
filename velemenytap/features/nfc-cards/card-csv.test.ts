import { describe, expect, it } from "vitest";
import { buildCardCsv, cardCsvFilename, type CardCsvRow } from "./card-csv";

/**
 * This file's output gets opened in Excel by a Hungarian user and then read
 * off the screen while they encode physical NFC cards one at a time. A card
 * written with the wrong link is invisible afterwards and permanent once
 * locked, so the things worth testing are the ones that would silently corrupt
 * a row: the delimiter, the encoding, and quoting.
 */

const card = (overrides: Partial<CardCsvRow> = {}): CardCsvRow => ({
  display_name: "Pult",
  location_name: "Belváros",
  status: "active",
  public_id: "7259eef2-b773-49bc-92b5-072ad336a230",
  ...overrides,
});

const SITE = "https://app.velemenytap.hu";

describe("the NFC card CSV", () => {
  it.each(["=1+1", "+SUM(1)", "-1+1", "@SUM(1)", "  =1+1", "\t=1+1"])("exports formula-like names as text: %s", (name) => {
    const csv = buildCardCsv([card({ display_name: name, location_name: name })], SITE);
    expect(csv).toContain(`'${name};'${name};`);
    expect(csv).toContain(`${SITE}/r/7259eef2-b773-49bc-92b5-072ad336a230`);
  });
  it("builds the full public URL for each card", () => {
    const csv = buildCardCsv([card()], SITE);
    expect(csv).toContain("https://app.velemenytap.hu/r/7259eef2-b773-49bc-92b5-072ad336a230");
  });

  it("starts with a BOM, without which Excel mangles every Hungarian name", () => {
    // "Kávézó" arriving as "KÃ¡vÃ©zÃ³" is not a cosmetic problem when the
    // column is what tells someone which card they are holding.
    expect(buildCardCsv([card()], SITE).charCodeAt(0)).toBe(0xfeff);
  });

  it("is semicolon-delimited, because Hungarian Excel splits on semicolons", () => {
    const csv = buildCardCsv([card()], SITE);
    const header = csv.replace("﻿", "").split("\r\n")[0];
    expect(header).toBe("Helyszín;Kártya;Állapot;Nyilvános link");
  });

  it("quotes a field containing the delimiter instead of splitting the row", () => {
    // A perfectly ordinary card name: "Terasz; 3. asztal".
    const csv = buildCardCsv([card({ display_name: "Terasz; 3. asztal" })], SITE);
    expect(csv).toContain('"Terasz; 3. asztal"');
    // Four fields, still.
    const row = csv.replace("﻿", "").split("\r\n")[1];
    expect(row.split('"')).toHaveLength(3);
  });

  it("escapes quotes by doubling them, per RFC 4180", () => {
    const csv = buildCardCsv([card({ location_name: 'A "Sarok" kávézó' })], SITE);
    expect(csv).toContain('"A ""Sarok"" kávézó"');
  });

  it("quotes a name containing a newline rather than emitting a broken row", () => {
    const csv = buildCardCsv([card({ display_name: "Pult\nelső" })], SITE);
    const body = csv.replace("﻿", "");
    // Header, then ONE data row (which itself contains the newline, quoted).
    expect(body.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(body).toContain('"Pult\nelső"');
  });

  it("sorts by location and then card name, the order cards are encoded in", () => {
    const csv = buildCardCsv(
      [
        card({ location_name: "Belváros", display_name: "Terasz" }),
        card({ location_name: "Alagút", display_name: "Pult" }),
        card({ location_name: "Belváros", display_name: "Pult" }),
      ],
      SITE,
    );
    const names = csv
      .replace("﻿", "")
      .split("\r\n")
      .slice(1)
      .filter(Boolean)
      .map((row) => row.split(";").slice(0, 2).join("/"));
    expect(names).toEqual(["Alagút/Pult", "Belváros/Pult", "Belváros/Terasz"]);
  });

  it("includes inactive cards, marked, rather than dropping them silently", () => {
    // A row count that disagrees with the dashboard is its own bug report.
    const csv = buildCardCsv([card({ status: "inactive" })], SITE);
    expect(csv).toContain("Inaktív");
    expect(csv.replace("﻿", "").split("\r\n").filter(Boolean)).toHaveLength(2);
  });

  it("names an unnamed card rather than leaving the cell empty", () => {
    expect(buildCardCsv([card({ display_name: null })], SITE)).toContain("Névtelen kártya");
  });

  it("emits a header even with no cards, so the file is never ambiguous", () => {
    const csv = buildCardCsv([], SITE);
    expect(csv.replace("﻿", "").split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("the CSV filename", () => {
  it("carries the date, so successive exports do not overwrite each other", () => {
    expect(cardCsvFilename(new Date(2026, 8, 14))).toBe("velemenytap-nfc-kartyak-2026-09-14.csv");
  });

  it("zero-pads, so the files sort chronologically in a folder", () => {
    expect(cardCsvFilename(new Date(2026, 0, 5))).toBe("velemenytap-nfc-kartyak-2026-01-05.csv");
  });
});
