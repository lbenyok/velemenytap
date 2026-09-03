"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyPoint } from "./aggregate";
import { formatDayLabel } from "./format";

const config = {
  avgRating: { label: "Átlagos értékelés", color: "var(--foreground)" },
} satisfies ChartConfig;

export function RatingTrendChart({ data }: { data: DailyPoint[] }) {
  // Only days with at least one submission have a rating; days a customer
  // didn't tap a card have nothing to average, not a rating of zero.
  const points = data.filter((d) => d.avgRating !== null);

  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <LineChart data={points} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDayLabel}
        />
        {/* Fixed 0-5 domain: ratings are bounded, so the axis should show
            the true range rather than auto-scaling to whatever the data
            happens to span, which would exaggerate small swings. */}
        <YAxis
          domain={[0, 5]}
          ticks={[0, 1, 2, 3, 4, 5]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={28}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(v) => formatDayLabel(v as string)} />}
        />
        <Line
          dataKey="avgRating"
          stroke="var(--color-avgRating)"
          strokeWidth={2}
          dot={{
            r: 3,
            fill: "var(--color-avgRating)",
            strokeWidth: 2,
            stroke: "var(--background)",
          }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--background)" }}
          connectNulls
        />
      </LineChart>
    </ChartContainer>
  );
}
