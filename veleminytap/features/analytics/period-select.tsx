"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PERIOD_ITEMS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export function PeriodSelect({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <Select
      items={PERIOD_ITEMS}
      value={value}
      onValueChange={(next) => {
        const params = new URLSearchParams(searchParams);
        params.set("days", next as string);
        router.push(`${pathname}?${params.toString()}`);
      }}
    >
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      {/* See nfc-card-form.tsx for why: alignItemWithTrigger breaks when a
          Select has exactly one option. This list is fixed at 3, but kept
          consistent with every other Select in the app rather than relying
          on that. */}
      <SelectContent alignItemWithTrigger={false}>
        {PERIOD_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
