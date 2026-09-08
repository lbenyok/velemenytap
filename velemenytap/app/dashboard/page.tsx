import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert, Inbox, Star, CalendarDays, TrendingUp } from "lucide-react";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOverviewStats } from "@/features/analytics/overview-data";
import { StatTile } from "@/features/analytics/stat-tile";
import { CompactDistribution } from "@/features/analytics/compact-distribution";
import { RatingStars } from "@/features/feedback/rating-stars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export const metadata: Metadata = { title: "Áttekintés — VéleményTap" };

export default async function DashboardPage() {
  const organization = await getCurrentOrganization();
  const stats = await getOverviewStats(organization?.id ?? 0);

  if (stats.unavailable) {
    // A failed stats query must never render as if the organization simply
    // has no feedback yet (round-2 finding R2-04) -- those are different
    // facts and look identical to a reader unless this state is distinct.
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Üdvözlünk, {organization?.name ?? "nálunk"}!
          </h1>
        </div>
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Nem sikerült betölteni az áttekintést</AlertTitle>
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
      <div>
        <h1
          className="text-2xl font-medium tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Üdvözlünk, {organization?.name ?? "nálunk"}!
        </h1>
        <p className="text-sm text-muted-foreground">
          Íme, hogyan alakulnak mostanában a dolgok.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Összes vélemény" value={String(stats.total)} icon={Inbox} />
        <StatTile
          label="Átlagos értékelés"
          value={stats.averageRating !== null ? stats.averageRating.toFixed(1) : "—"}
          icon={Star}
        />
        <StatTile label="Ma" value={String(stats.today)} icon={CalendarDays} />
        <StatTile label="Ezen a héten" value={String(stats.thisWeek)} icon={TrendingUp} />
        <StatTile
          label="Megoldatlan negatív"
          value={String(stats.unresolvedNegative)}
          icon={TriangleAlert}
          tone="attention"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Értékelések megoszlása</CardTitle>
          </CardHeader>
          <CardContent>
            <CompactDistribution buckets={stats.distribution} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Legutóbbi vélemények</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recent.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Még nincs vélemény</EmptyTitle>
                  <EmptyDescription>
                    Amint egy vásárló megkoppint egy NFC-kártyát és értékeli a
                    látogatását, itt fog megjelenni.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="divide-y">
                {stats.recent.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <RatingStars rating={item.rating} />
                        <span className="text-sm text-muted-foreground">
                          {item.location_name}
                        </span>
                      </div>
                      {item.feedback_text ? (
                        <p className="truncate text-sm text-muted-foreground">
                          {item.feedback_text}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {new Date(item.created_at).toLocaleDateString("hu-HU")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        <Link href="/dashboard/feedback" className="underline underline-offset-4 hover:text-foreground">
          Összes vélemény megtekintése
        </Link>
        {" · "}
        <Link href="/dashboard/analytics" className="underline underline-offset-4 hover:text-foreground">
          Elemzés megtekintése
        </Link>
      </p>
    </div>
  );
}
