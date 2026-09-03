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
          <FieldLabel htmlFor="location_id">Helyszín</FieldLabel>
          <Select
            items={locations}
            name="location_id"
            defaultValue={card ? String(card.location_id) : undefined}
            required
            disabled={!hasLocations}
          >
            <SelectTrigger id="location_id" className="w-full">
              <SelectValue placeholder="Válassz egy helyszínt" />
            </SelectTrigger>
            {/* alignItemWithTrigger (the default) positions the matching
                item exactly over the trigger. With exactly one option --
                the common case for a brand-new org with one location --
                that positioning breaks (the option lands at (0,0) and
                can't be clicked), because there's no other item to force
                the popup into its normal below-trigger layout. Disabling
                it makes the list render the same way regardless of how
                many options there are. */}
            <SelectContent alignItemWithTrigger={false}>
              {locations.map((location) => (
                <SelectItem key={location.value} value={location.value}>
                  {location.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!hasLocations ? (
            <FieldDescription className="text-destructive">
              Adj hozzá egy helyszínt, mielőtt NFC-kártyát hoznál létre.
            </FieldDescription>
          ) : null}
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="display_name">Kártya neve</FieldLabel>
          <Input
            id="display_name"
            name="display_name"
            defaultValue={card?.display_name ?? ""}
            placeholder="pl. 4-es asztal, Front pult"
            aria-invalid={!!state.error}
          />
          <FieldDescription
            className={state.error ? "text-destructive" : undefined}
          >
            {state.error ??
              "Nem kötelező. Segít megkülönböztetni az ugyanazon a helyszínen lévő kártyákat."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending || !hasLocations}>
            {isPending ? "Mentés..." : card ? "Változtatások mentése" : "Kártya hozzáadása"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
