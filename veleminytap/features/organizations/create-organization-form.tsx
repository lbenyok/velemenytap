"use client";

import { useActionState } from "react";
import {
  createOrganizationAction,
  type CreateOrganizationState,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";

const initialState: CreateOrganizationState = {};

export function CreateOrganizationForm() {
  const [state, formAction, isPending] = useActionState(
    createOrganizationAction,
    initialState,
  );

  return (
    <form action={formAction} noValidate>
      <FieldGroup>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="name">Business name</FieldLabel>
          <Input
            id="name"
            name="name"
            autoComplete="organization"
            placeholder="e.g. Kávézó Ízlelő"
            required
            aria-invalid={!!state.error}
          />
          {state.error ? (
            <FieldDescription className="text-destructive">
              {state.error}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Creating..." : "Continue"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
