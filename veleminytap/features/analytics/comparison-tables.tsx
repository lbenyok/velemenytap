import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LocationStats, CardStats } from "./aggregate";

export function LocationComparisonTable({ rows }: { rows: LocationStats[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No feedback in this period.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Location</TableHead>
          <TableHead className="text-right">Feedback</TableHead>
          <TableHead className="text-right">Avg rating</TableHead>
          <TableHead className="text-right">Resolved</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.locationId}>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell className="text-right tabular-nums">{row.count}</TableCell>
            <TableCell className="text-right tabular-nums">{row.avgRating.toFixed(1)}</TableCell>
            <TableCell className="text-right tabular-nums">{row.resolvedPct}%</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CardPerformanceTable({ rows }: { rows: CardStats[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No feedback in this period.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Card</TableHead>
          <TableHead>Location</TableHead>
          <TableHead className="text-right">Feedback</TableHead>
          <TableHead className="text-right">Avg rating</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.cardId}>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell className="text-muted-foreground">{row.locationName}</TableCell>
            <TableCell className="text-right tabular-nums">{row.count}</TableCell>
            <TableCell className="text-right tabular-nums">{row.avgRating.toFixed(1)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
