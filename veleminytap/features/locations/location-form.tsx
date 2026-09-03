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
  updated_at: string;
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
          <FieldLabel htmlFor="name">Location name</FieldLabel>
          <Input
            id="name"
            name="name"
            defaultValue={location?.name}
            placeholder="e.g. Belváros"
            required
            aria-invalid={!!state.error}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="address">Address</FieldLabel>
          <Textarea
            id="address"
            name="address"
            defaultValue={location?.address ?? ""}
            placeholder="Street, city"
            rows={2}
          />
          <FieldDescription>Optional.</FieldDescription>
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="google_review_url">
            Google Review link
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
              "Where customers land when they choose to leave a Google review. Optional, can be added later."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? "Saving..."
              : location
                ? "Save changes"
                : "Add location"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
