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
  // Bumped only when the dialog opens, so the form remounts with fresh
  // defaultValues each time it's opened for editing. Deliberately NOT
  // keyed on location.updated_at: a successful save's revalidatePath
  // delivers new props in the same response as the action result, so
  // keying on updated_at would remount (and reset) the form the instant
  // it succeeds -- before its useActionState success state could ever be
  // observed, silently breaking the "close dialog on success" effect
  // below. (Confirmed this actually happens, not just theoretical, while
  // building the near-identical NFC card dialog.)
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {location ? "Helyszín szerkesztése" : "Helyszín hozzáadása"}
          </DialogTitle>
        </DialogHeader>
        <LocationForm
          key={session}
          location={location}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
