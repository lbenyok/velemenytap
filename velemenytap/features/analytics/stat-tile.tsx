import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  icon: Icon,
  tone = "brand",
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  /** "attention" is for tiles that call out something to act on (e.g.
   * unresolved negative feedback) -- same chip treatment, destructive tint
   * instead of brand, so it doesn't compete with genuinely urgent state
   * elsewhere in the product while still standing out from the others. */
  tone?: "brand" | "attention";
}) {
  return (
    <Card>
      <CardContent className="space-y-3">
        {Icon ? (
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-lg",
              tone === "attention"
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/10 text-primary",
            )}
          >
            <Icon className="size-4.5" strokeWidth={2} />
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-3xl font-semibold tracking-tight">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
