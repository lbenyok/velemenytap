"use client";

import { useActionState, useEffect } from "react";
import {
  createNfcCardAction,
  updateNfcCardAction,
  type NfcCardActionState,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type NfcCardFormValues = {
  id: number;
  display_name: string | null;
  location_id: number;
};

export type LocationOption = { value: string; label: string };

const initialState: NfcCardActionState = {};

export function NfcCardForm({
  card,
  locations,
  onSuccess,
}: {
  card?: NfcCardFormValues;
  locations: LocationOption[];
  onSuccess?: () => void;
}) {
  const action = card ? updateNfcCardAction : createNfcCardAction;
  const [state, formAction, isPending] = useActionState(action, initialState);

  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const hasLocations = locations.length > 0;

  return (
    <form action={formAction} noValidate>
      {card ? <input type="hidden" name="id" value={card.id} /> : null}
      <FieldGroup>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="location_id">Location</FieldLabel>
          <Select
            items={locations}
            name="location_id"
            defaultValue={card ? String(card.location_id) : undefined}
            required
            disabled={!hasLocations}
          >
            <SelectTrigger id="location_id" className="w-full">
              <SelectValue placeholder="Choose a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.value} value={location.value}>
                  {location.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!hasLocations ? (
            <FieldDescription className="text-destructive">
              Add a location first before creating NFC cards.
            </FieldDescription>
          ) : null}
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="display_name">Card name</FieldLabel>
          <Input
            id="display_name"
            name="display_name"
            defaultValue={card?.display_name ?? ""}
            placeholder="e.g. Table 4, Front counter"
            aria-invalid={!!state.error}
          />
          <FieldDescription
            className={state.error ? "text-destructive" : undefined}
          >
            {state.error ??
              "Optional. Helps you tell cards at the same location apart."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending || !hasLocations}>
            {isPending ? "Saving..." : card ? "Save changes" : "Add card"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
