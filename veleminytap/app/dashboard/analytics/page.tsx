import type { Metadata } from "next";
import { Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getAnalyticsData } from "@/features/analytics/queries";
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
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

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
  const data = await getAnalyticsData(organization?.id ?? 0, days);

  if (data.unavailable) {
    // A failed aggregate query must never render as "0 feedback this
    // period" -- those are different facts (round-2 finding R2-04).
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Elemzés</h1>
          <Suspense>
            <PeriodSelect value={String(days)} />
          </Suspense>
        </div>
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Nem sikerült betölteni az elemzést</AlertTitle>
          <AlertDescription>
            Kérjük, próbáld újra az oldal frissítésével. Ha a hiba továbbra is
            fennáll, keresd az ügyfélszolgálatot.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Elemzés</h1>
          <p className="text-sm text-muted-foreground">
            {data.total} beküldött vélemény ebben az időszakban.
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
            <VolumeChart data={data.dailySeries} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Átlagos értékelés trendje</CardTitle>
          </CardHeader>
          <CardContent>
            <RatingTrendChart data={data.dailySeries} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Értékelések megoszlása</CardTitle>
          </CardHeader>
          <CardContent>
            <RatingDistributionChart data={data.distribution} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Megoldva / megoldatlan</CardTitle>
          </CardHeader>
          <CardContent>
            <ResolvedMeter
              resolved={data.resolved.resolved}
              total={data.resolved.total}
              pct={data.resolved.pct}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Helyszínek</CardTitle>
          </CardHeader>
          <CardContent>
            <LocationComparisonTable rows={data.byLocation} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>NFC kártyák</CardTitle>
          </CardHeader>
          <CardContent>
            <CardPerformanceTable rows={data.byCard} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
