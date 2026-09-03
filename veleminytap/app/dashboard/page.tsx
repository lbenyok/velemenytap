import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOverviewStats } from "@/features/analytics/overview-data";
import { StatTile } from "@/features/analytics/stat-tile";
import { CompactDistribution } from "@/features/analytics/compact-distribution";
import { RatingStars } from "@/features/feedback/rating-stars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

export const metadata: Metadata = { title: "Dashboard — VéleményTap" };

export default async function DashboardPage() {
  const organization = await getCurrentOrganization();
  const stats = await getOverviewStats(organization?.id ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome to {organization?.name ?? "your business"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Here&apos;s how things are going.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Total feedback" value={String(stats.total)} />
        <StatTile
          label="Average rating"
          value={stats.averageRating !== null ? stats.averageRating.toFixed(1) : "—"}
        />
        <StatTile label="Today" value={String(stats.today)} />
        <StatTile label="This week" value={String(stats.thisWeek)} />
        <StatTile label="Unresolved negative" value={String(stats.unresolvedNegative)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Rating distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <CompactDistribution buckets={stats.distribution} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent feedback</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recent.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No feedback yet</EmptyTitle>
                  <EmptyDescription>
                    Once customers tap an NFC card and rate their visit, it&apos;ll show
                    up here.
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
                      {new Date(item.created_at).toLocaleDateString()}
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
          View all feedback
        </Link>
        {" · "}
        <Link href="/dashboard/analytics" className="underline underline-offset-4 hover:text-foreground">
          View analytics
        </Link>
      </p>
    </div>
  );
}
