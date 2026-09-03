import { Badge } from "@/components/ui/badge";

const LABEL: Record<string, string> = {
  high: "Magas prioritás",
  medium: "Közepes prioritás",
  normal: "Normál",
};

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "normal") {
    // Not worth a badge for the common case -- only flag what needs
    // attention, per "prioritize actionable metrics over vanity metrics."
    return null;
  }
  return (
    <Badge variant={priority === "high" ? "destructive" : "secondary"}>
      {LABEL[priority] ?? priority}
    </Badge>
  );
}
