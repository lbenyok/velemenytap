import type { RatingBucket } from "./queries";

export function CompactDistribution({ buckets }: { buckets: RatingBucket[] }) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);

  if (total === 0) {
    return <p className="text-sm text-muted-foreground">Még nincs vélemény.</p>;
  }

  return (
    <div className="space-y-1.5">
      {[...buckets].reverse().map((bucket) => {
        const pct = Math.round((bucket.count / total) * 100);
        return (
          <div key={bucket.rating} className="flex items-center gap-3 text-sm">
            <span className="w-16 shrink-0 text-muted-foreground">{bucket.rating} csillag</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
