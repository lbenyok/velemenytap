"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseFeedbackFilters } from "./filter-params";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type LocationOption = { value: string; label: string };
export type CardOption = { value: string; label: string };

const STATUS_ITEMS = [
  { value: "all", label: "Minden állapot" },
  { value: "new", label: "Új" },
  { value: "in_progress", label: "Folyamatban" },
  { value: "resolved", label: "Megoldva" },
];

const RATING_ITEMS = [
  { value: "all", label: "Minden értékelés" },
  { value: "5", label: "5 csillag" },
  { value: "4", label: "4 csillag" },
  { value: "3", label: "3 csillag" },
  { value: "2", label: "2 csillag" },
  { value: "1", label: "1 csillag" },
];

const DAYS_ITEMS = [
  { value: "all", label: "Minden időszak" },
  { value: "7", label: "Elmúlt 7 nap" },
  { value: "30", label: "Elmúlt 30 nap" },
  { value: "90", label: "Elmúlt 90 nap" },
];

export function FeedbackFilters({
  locations,
  cards,
}: {
  locations: LocationOption[];
  cards: CardOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Feeding a raw query-string value straight into a Select renders an empty
  // control whenever it matches no item -- which is what `?rating=abc`, or a
  // repeated `?rating=1&rating=2`, used to produce. Parse to the same values
  // the server uses, so an unrecognized filter shows as "all" in both places.
  function singleParam(key: string) {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  }
  const filters = parseFeedbackFilters({
    status: singleParam("status"),
    rating: singleParam("rating"),
    location: singleParam("location"),
    card: singleParam("card"),
    days: singleParam("days"),
  });

  const locationItems = [{ value: "all", label: "Minden helyszín" }, ...locations];
  const cardItems = [{ value: "all", label: "Minden NFC kártya" }, ...cards];

  // A well-formed id that no longer belongs to this organization (a deleted
  // location, or a link shared from another org) would otherwise leave the
  // Select blank with no way to see what is being filtered on.
  if (
    filters.locationId !== "all" &&
    !locations.some((item) => item.value === filters.locationId)
  ) {
    locationItems.push({ value: filters.locationId, label: "Nem elérhető helyszín" });
  }
  if (
    filters.cardId !== "all" &&
    !cards.some((item) => item.value === filters.cardId)
  ) {
    cardItems.push({ value: filters.cardId, label: "Nem elérhető kártya" });
  }

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams);
    if (value === "all") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    // Any filter change starts back at the first page.
    params.delete("cursor");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  // Every SelectContent below disables alignItemWithTrigger: it breaks when
  // a Select has exactly one option (the matching item lands at (0,0) and
  // can't be clicked) -- see nfc-card-form.tsx. Only the location filter can
  // actually hit that (an org with zero locations leaves just "All
  // locations"), but all four are kept consistent rather than relying on
  // the other three always having a fixed item count.
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        items={STATUS_ITEMS}
        value={filters.status}
        onValueChange={(v) => setParam("status", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {STATUS_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={RATING_ITEMS}
        value={filters.rating}
        onValueChange={(v) => setParam("rating", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {RATING_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={locationItems}
        value={filters.locationId}
        onValueChange={(v) => setParam("location", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {locationItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={cardItems}
        value={filters.cardId}
        onValueChange={(v) => setParam("card", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {cardItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={DAYS_ITEMS}
        value={filters.days}
        onValueChange={(v) => setParam("days", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {DAYS_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
