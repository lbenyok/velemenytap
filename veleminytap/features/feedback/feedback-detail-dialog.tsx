"use client";

import { useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RatingStars } from "./rating-stars";
import { FeedbackDetailForm } from "./feedback-detail-form";
import { PriorityBadge } from "./priority-badge";

export type FeedbackDetailRow = {
  id: number;
  rating: number;
  feedback_text: string | null;
  status: string;
  priority: string;
  internal_note: string | null;
  created_at: string;
  location_name: string;
  card_name: string | null;
};

export function FeedbackDetailDialog({
  feedback,
  trigger,
}: {
  feedback: FeedbackDetailRow;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  // See locations/nfc-cards dialogs for why this is keyed on an
  // open-session counter rather than on the record's own data.
  const [session, setSession] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSession((s) => s + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RatingStars rating={feedback.rating} />
            <PriorityBadge priority={feedback.priority} />
          </DialogTitle>
          <DialogDescription>
            {feedback.location_name}
            {feedback.card_name ? ` · ${feedback.card_name}` : ""} ·{" "}
            {new Date(feedback.created_at).toLocaleString("hu-HU")}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-lg border bg-muted/30 p-3 text-sm">
          {feedback.feedback_text ?? (
            <span className="text-muted-foreground">Nincs írásos vélemény.</span>
          )}
        </p>
        <FeedbackDetailForm
          key={session}
          id={feedback.id}
          status={feedback.status}
          internalNote={feedback.internal_note}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
