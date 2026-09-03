import type { Metadata } from "next";
import { Suspense } from "react";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getAnalyticsData } from "@/features/analytics/queries";
import {
  dailySeries,
  ratingDistribution,
  resolvedStats,
  byLocation,
  byCard,
} from "@/features/analytics/aggregate";
import { PeriodSelect } from "@/features/analytics/period-select";
import { VolumeChart } from "@/features/analytics/volume-chart";
import { RatingTrendChart } from "@/features/analytics/rating-trend-chart";
import { RatingDistributionChart } from "@/features/analytics/rating-distribution-chart";
import { ResolvedMeter } from "@/features/analytics/resolved-meter";
import {
  LocationComparisonTable,
  CardPerformanceTable,
} from "@/features/analytics/comparison-tables";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Elemzés — VéleményTap" };

const VALID_PERIODS = ["7", "30", "90"] as const;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const sp = await searchParams;
  const days = Number(VALID_PERIODS.find((p) => p === sp.days) ?? "30");

  const organization = await getCurrentOrganization();
  const { feedback, locationNames, cardInfo } = await getAnalyticsData(
    organization?.id ?? 0,
    days,
  );

  const volume = dailySeries(feedback, days);
  const distribution = ratingDistribution(feedback);
  const resolved = resolvedStats(feedback);
  const locations = byLocation(feedback, locationNames);
  const cards = byCard(feedback, cardInfo);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Elemzés</h1>
          <p className="text-sm text-muted-foreground">
            {feedback.length} beküldött vélemény ebben az időszakban.
          </p>
        </div>
        <Suspense>
          <PeriodSelect value={String(days)} />
        </Suspense>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Vélemények száma</CardTitle>
          </CardHeader>
          <CardContent>
            <VolumeChart data={volume} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Átlagos értékelés trendje</CardTitle>
          </CardHeader>
          <CardContent>
            <RatingTrendChart data={volume} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Értékelések megoszlása</CardTitle>
          </CardHeader>
          <CardContent>
            <RatingDistributionChart data={distribution} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Megoldva / megoldatlan</CardTitle>
          </CardHeader>
          <CardContent>
            <ResolvedMeter resolved={resolved.resolved} total={resolved.total} pct={resolved.pct} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Helyszínek</CardTitle>
          </CardHeader>
          <CardContent>
            <LocationComparisonTable rows={locations} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>NFC kártyák</CardTitle>
          </CardHeader>
          <CardContent>
            <CardPerformanceTable rows={cards} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
