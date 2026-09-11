/**
 * Content for the first-time dashboard tour. Kept as plain data, separate
 * from the rendering component, so the Hungarian copy can be reviewed and
 * edited on its own -- see DECISIONS.md for why this product's UI text is
 * translated in place rather than run through an i18n framework.
 *
 * `navTarget`, where present, must match a real `data-tour` attribute on
 * the corresponding link in `app/dashboard/dashboard-nav.tsx` -- the tour
 * looks these up by attribute selector, never by matching visible text
 * (visible labels are Hungarian copy that can change independently of
 * this file). A step with `navTarget: null` has no on-page element to
 * highlight -- it renders as a plain centered step.
 */
export type TourStep = {
  id: string;
  navTarget: string | null;
  title: string;
  body: string[];
  /** Only the final step has one -- a concrete next action, not a link to
   * "explore more" for its own sake. */
  action?: { label: string; href: string };
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "overview",
    navTarget: "nav-overview",
    title: "Áttekintés",
    body: [
      "Ez az áttekintés: itt látod a beérkező véleményeket, az átlagos értékelést, a megoldatlan negatív véleményeket és a legutóbbi aktivitást.",
    ],
  },
  {
    id: "locations",
    navTarget: "nav-locations",
    title: "Helyszínek",
    body: [
      "Itt hozod létre és kezeled a vállalkozásod helyszíneit.",
      "Minden üzletedet külön helyszínként veheted fel, legyen szó kávézóról, boltról vagy szalonról.",
    ],
  },
  {
    id: "nfc-cards",
    navTarget: "nav-nfc-cards",
    title: "NFC-kártyák",
    body: [
      "Minden kártya egy helyszínhez tartozik.",
      "Amikor egy vásárló megkoppintja, a kártyához tartozó helyszín nyilvános vélemény oldala nyílik meg neki.",
    ],
  },
  {
    id: "feedback",
    navTarget: "nav-feedback",
    title: "Vélemények",
    body: [
      "A beküldött értékelések és megjegyzések itt jelennek meg. Szűrheted őket helyszín, kártya, státusz vagy dátum szerint, módosíthatod az állapotukat, és belső megjegyzést fűzhetsz hozzájuk.",
      "Ez különáll a Google-értékeléstől: minden vásárló ugyanazt a Google-értékelési lehetőséget kapja, függetlenül attól, hány csillagot adott.",
    ],
  },
  {
    id: "analytics",
    navTarget: "nav-analytics",
    title: "Elemzés",
    body: [
      "Itt látod az értékelések átlagát, a vélemények számának alakulását, és hogy melyik helyszín vagy kártya hogyan teljesít.",
    ],
  },
  {
    id: "settings",
    navTarget: "nav-settings",
    title: "Beállítások",
    body: [
      "Itt kezeled a vállalkozásod nevét, logóját és az értesítési e-mail címet.",
      "Alacsony értékelésnél e-mailes értesítést is kaphat a csapatod. Ha megadsz egy értesítési címet, előbb meg kell erősítened, mielőtt aktívvá válik.",
    ],
  },
  {
    id: "next-step",
    navTarget: null,
    title: "Kezdjük is el",
    body: [
      "A következő lépés, hogy létrehozd az első helyszínedet. Utána már hozzáadhatsz egy NFC-kártyát is.",
    ],
    // Matches the label the Locations page's own empty-state button uses
    // (features/locations/locations-table.tsx) -- the same word for the
    // same action, not a synonym invented for this one screen.
    action: { label: "Helyszín hozzáadása", href: "/dashboard/locations" },
  },
];

export const TOUR_WELCOME = {
  title: "Üdvözlünk a VéleményTapban!",
  body: [
    "Az NFC-kártyáiddal a vásárlóid pár másodperc alatt értékelik a látogatásukat.",
    "A beérkező véleményeket itt, az irányítópulton látod és kezeled.",
  ],
};
