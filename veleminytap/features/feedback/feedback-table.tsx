import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { RatingStars } from "./rating-stars";
import { PriorityBadge } from "./priority-badge";
import { FeedbackDetailDialog, type FeedbackDetailRow } from "./feedback-detail-dialog";

const STATUS_LABEL: Record<string, string> = {
  new: "Új",
  in_progress: "Folyamatban",
  resolved: "Megoldva",
};

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "new") return "default";
  if (status === "resolved") return "outline";
  return "secondary";
}

export function FeedbackTable({
  rows,
  hasActiveFilters,
}: {
  rows: FeedbackDetailRow[];
  hasActiveFilters: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {hasActiveFilters
              ? "Nincs a szűrésnek megfelelő vélemény"
              : "Még nincs vélemény"}
          </EmptyTitle>
          <EmptyDescription>
            {hasActiveFilters
              ? "Próbáld meg tágítani a szűrőket."
              : "Az NFC kártyáidon keresztül beküldött vélemények itt fognak megjelenni."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Értékelés</TableHead>
          <TableHead>Vélemény</TableHead>
          <TableHead>Helyszín</TableHead>
          <TableHead>Kártya</TableHead>
          <TableHead>Dátum</TableHead>
          <TableHead>Állapot</TableHead>
          <TableHead className="text-right">Műveletek</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          // Only draw attention to priority while it's still unresolved --
          // once handled, it shouldn't keep visually shouting.
          const needsAttention = row.priority === "high" && row.status !== "resolved";
          return (
            <TableRow
              key={row.id}
              className={cn(needsAttention && "bg-destructive/5")}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <RatingStars rating={row.rating} />
                  <PriorityBadge priority={row.priority} />
                </div>
              </TableCell>
              <TableCell className="max-w-64 truncate text-muted-foreground">
                {row.feedback_text ?? "—"}
              </TableCell>
              <TableCell>{row.location_name}</TableCell>
              <TableCell className="text-muted-foreground">
                {row.card_name ?? "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(row.created_at).toLocaleDateString("hu-HU")}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant(row.status)}>
                  {STATUS_LABEL[row.status] ?? row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <FeedbackDetailDialog
                  feedback={row}
                  trigger={
                    <Button variant="outline" size="sm">
                      Megtekintés
                    </Button>
                  }
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
