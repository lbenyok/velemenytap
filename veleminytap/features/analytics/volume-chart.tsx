"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyPoint } from "./queries";
import { formatDayLabel } from "./format";

const config = {
  count: { label: "Vélemények", color: "var(--primary)" },
} satisfies ChartConfig;

export function VolumeChart({ data }: { data: DailyPoint[] }) {
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <LineChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDayLabel}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={28}
          allowDecimals={false}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(v) => formatDayLabel(v as string)} />}
        />
        <Line
          dataKey="count"
          stroke="var(--color-count)"
          strokeWidth={2}
          dot={{ r: 3, fill: "var(--color-count)", strokeWidth: 2, stroke: "var(--background)" }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--background)" }}
        />
      </LineChart>
    </ChartContainer>
  );
}
