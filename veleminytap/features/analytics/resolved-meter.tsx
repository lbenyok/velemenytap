export function ResolvedMeter({
  resolved,
  total,
  pct,
}: {
  resolved: number;
  total: number;
  pct: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
        <span className="text-sm text-muted-foreground">
          {resolved} of {total} resolved
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground transition-all"
          style={{ width: `${total > 0 ? pct : 0}%` }}
        />
      </div>
    </div>
  );
}
