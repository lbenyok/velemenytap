import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export function RatingStars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(
            "size-3.5",
            n <= rating
              ? "fill-foreground text-foreground"
              : "fill-none text-muted-foreground/40",
          )}
          strokeWidth={1.5}
        />
      ))}
    </div>
  );
}
