"use client";

import { useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LocationForm, type LocationFormValues } from "./location-form";

export function LocationDialog({
  trigger,
  location,
}: {
  trigger: ReactElement;
  location?: LocationFormValues;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {location ? "Edit location" : "Add location"}
          </DialogTitle>
        </DialogHeader>
        <LocationForm
          key={location?.updated_at ?? "new"}
          location={location}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
