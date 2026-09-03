"use client";

import { useActionState } from "react";
import {
  updateOrganizationSettingsAction,
  type SettingsActionState,
} from "./settings-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";

export type SettingsFormValues = {
  name: string;
  notification_email: string | null;
  logo_url: string | null;
};

const initialState: SettingsActionState = {};

export function SettingsForm({ organization }: { organization: SettingsFormValues }) {
  const [state, formAction, isPending] = useActionState(
    updateOrganizationSettingsAction,
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
            defaultValue={organization.name}
            placeholder="e.g. Kávézó Kft."
            required
            aria-invalid={!!state.error}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="notification_email">Notification email</FieldLabel>
          <Input
            id="notification_email"
            name="notification_email"
            type="email"
            defaultValue={organization.notification_email ?? ""}
            placeholder="alerts@yourbusiness.com"
          />
          <FieldDescription>
            Where negative-feedback alerts are sent. Leave blank to notify all team
            members instead.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="logo_url">Logo URL</FieldLabel>
          <Input
            id="logo_url"
            name="logo_url"
            type="url"
            defaultValue={organization.logo_url ?? ""}
            placeholder="https://..."
          />
          <FieldDescription>
            Link to a hosted image. Shown on your public feedback pages. Optional.
          </FieldDescription>
        </Field>
        <Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
            {state.error ? (
              <span className="text-sm text-destructive">{state.error}</span>
            ) : null}
            {state.success ? (
              <span className="text-sm text-muted-foreground">Saved.</span>
            ) : null}
          </div>
        </Field>
      </FieldGroup>
    </form>
  );
}
