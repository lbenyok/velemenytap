"use client";

import { useActionState, useEffect } from "react";
import { updateFeedbackAction, type UpdateFeedbackState } from "./inbox-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_ITEMS = [
  { value: "new", label: "New" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

const initialState: UpdateFeedbackState = {};

export function FeedbackDetailForm({
  id,
  status,
  internalNote,
  onSuccess,
}: {
  id: number;
  status: string;
  internalNote: string | null;
  onSuccess?: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    updateFeedbackAction,
    initialState,
  );

  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="status">Status</FieldLabel>
          <Select items={STATUS_ITEMS} name="status" defaultValue={status} required>
            <SelectTrigger id="status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            {/* See nfc-card-form.tsx for why: alignItemWithTrigger breaks
                when a Select has exactly one option. This list is fixed at
                3, but kept consistent with every other Select in the app
                rather than relying on that. */}
            <SelectContent alignItemWithTrigger={false}>
              {STATUS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="internal_note">Internal note</FieldLabel>
          <Textarea
            id="internal_note"
            name="internal_note"
            defaultValue={internalNote ?? ""}
            rows={4}
            placeholder="Not visible to the customer"
            aria-invalid={!!state.error}
          />
          <FieldDescription className={state.error ? "text-destructive" : undefined}>
            {state.error ?? "Visible only to your team."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
