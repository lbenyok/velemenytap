"use client";

import { useActionState, useEffect } from "react";
import {
  createLocationAction,
  updateLocationAction,
  type LocationActionState,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";

export type LocationFormValues = {
  id: number;
  name: string;
  address: string | null;
  google_review_url: string | null;
};

const initialState: LocationActionState = {};

export function LocationForm({
  location,
  onSuccess,
}: {
  location?: LocationFormValues;
  onSuccess?: () => void;
}) {
  const action = location ? updateLocationAction : createLocationAction;
  const [state, formAction, isPending] = useActionState(action, initialState);

  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // Only re-run when a fresh success/error state is produced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} noValidate>
      {location ? <input type="hidden" name="id" value={location.id} /> : null}
      <FieldGroup>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="name">Helyszín neve</FieldLabel>
          <Input
            id="name"
            name="name"
            defaultValue={location?.name}
            placeholder="pl. Belváros"
            required
            aria-invalid={!!state.error}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="address">Cím</FieldLabel>
          <Textarea
            id="address"
            name="address"
            defaultValue={location?.address ?? ""}
            placeholder="Utca, város"
            rows={2}
          />
          <FieldDescription>Nem kötelező.</FieldDescription>
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="google_review_url">
            Google-értékelés link
          </FieldLabel>
          <Input
            id="google_review_url"
            name="google_review_url"
            type="url"
            defaultValue={location?.google_review_url ?? ""}
            placeholder="https://g.page/r/..."
            aria-invalid={!!state.error}
          />
          <FieldDescription
            className={state.error ? "text-destructive" : undefined}
          >
            {state.error ??
              "Ide jutnak a vásárlók, ha Google-értékelést szeretnének írni. Nem kötelező, később is megadható."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? "Mentés..."
              : location
                ? "Változtatások mentése"
                : "Helyszín hozzáadása"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
