"use client";

import { useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  NfcCardForm,
  type NfcCardFormValues,
  type LocationOption,
} from "./nfc-card-form";

export function NfcCardDialog({
  trigger,
  card,
  locations,
}: {
  trigger: ReactElement;
  card?: NfcCardFormValues;
  locations: LocationOption[];
}) {
  const [open, setOpen] = useState(false);
  // Bumped only when the dialog opens, so the form remounts with fresh
  // defaultValues each time it's opened for editing. Deliberately NOT
  // keyed on card.updated_at: a successful save's revalidatePath delivers
  // new props in the same response as the action result, so keying on
  // updated_at would remount (and reset) the form the instant it succeeds
  // -- before its useActionState success state could ever be observed,
  // silently breaking the "close dialog on success" effect below.
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
          <DialogTitle>{card ? "Kártya szerkesztése" : "NFC kártya hozzáadása"}</DialogTitle>
        </DialogHeader>
        <NfcCardForm
          key={session}
          card={card}
          locations={locations}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
