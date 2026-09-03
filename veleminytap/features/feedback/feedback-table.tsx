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
import { FeedbackDetailDialog, type FeedbackDetailRow } from "./feedback-detail-dialog";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  in_progress: "In progress",
  resolved: "Resolved",
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
            {hasActiveFilters ? "No feedback matches these filters" : "No feedback yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasActiveFilters
              ? "Try widening your filters."
              : "Feedback submitted through your NFC cards will show up here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Rating</TableHead>
          <TableHead>Feedback</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Card</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <RatingStars rating={row.rating} />
            </TableCell>
            <TableCell className="max-w-64 truncate text-muted-foreground">
              {row.feedback_text ?? "—"}
            </TableCell>
            <TableCell>{row.location_name}</TableCell>
            <TableCell className="text-muted-foreground">
              {row.card_name ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(row.created_at).toLocaleDateString()}
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
                    View
                  </Button>
                }
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
