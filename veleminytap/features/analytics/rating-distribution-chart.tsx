"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { RatingBucket } from "./queries";

const config = {
  count: { label: "Vélemények", color: "var(--foreground)" },
} satisfies ChartConfig;

export function RatingDistributionChart({ data }: { data: RatingBucket[] }) {
  const chartData = data.map((d) => ({ ...d, label: `${d.rating}★` }));

  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <BarChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={28}
          allowDecimals={false}
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ChartContainer>
  );
}
