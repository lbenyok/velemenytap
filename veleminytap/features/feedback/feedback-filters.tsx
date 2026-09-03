"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type LocationOption = { value: string; label: string };

const STATUS_ITEMS = [
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

const RATING_ITEMS = [
  { value: "all", label: "All ratings" },
  { value: "5", label: "5 stars" },
  { value: "4", label: "4 stars" },
  { value: "3", label: "3 stars" },
  { value: "2", label: "2 stars" },
  { value: "1", label: "1 star" },
];

const DAYS_ITEMS = [
  { value: "all", label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export function FeedbackFilters({ locations }: { locations: LocationOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const locationItems = [{ value: "all", label: "All locations" }, ...locations];

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
        value={searchParams.get("status") ?? "all"}
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
        value={searchParams.get("rating") ?? "all"}
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
        value={searchParams.get("location") ?? "all"}
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
        items={DAYS_ITEMS}
        value={searchParams.get("days") ?? "all"}
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
