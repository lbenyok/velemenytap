"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { resendConfirmationAction, type RecoveryState } from "./recovery-actions";

export function ResendConfirmationForm() {
  const [state, action, pending] = useActionState(resendConfirmationAction, {} as RecoveryState);
  if (state.success) return <p role="status" className="text-sm">Ha ez a fiók még megerősítésre vár, új linket küldünk az e-mail címedre.</p>;
  return <form action={action}><FieldGroup>
    <Field><FieldLabel htmlFor="confirmation_email">E-mail cím</FieldLabel><Input id="confirmation_email" name="email" type="email" autoComplete="email" required /></Field>
    {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? "Küldés…" : "Új megerősítő linket kérek"}</Button>
  </FieldGroup></form>;
}
