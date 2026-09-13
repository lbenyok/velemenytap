"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { requestPasswordResetAction, updatePasswordAction, type RecoveryState } from "./recovery-actions";

export function RecoveryForm({ update = false, requiresCurrentPassword = false }: { update?: boolean; requiresCurrentPassword?: boolean }) {
  const [state, action, pending] = useActionState(update ? updatePasswordAction : requestPasswordResetAction, {} as RecoveryState);
  if (state.success) return (
    <div className="space-y-4 text-sm">
      <p role="status">{update ? "Az új jelszavadat elmentettük." : "Ha tartozik fiók ehhez a címhez, elküldjük a jelszó-visszaállító linket. Nézd meg a spam mappát is. A linket ebben a böngészőben nyisd meg."}</p>
      <Link href={update ? "/dashboard" : "/login"} className="underline underline-offset-4">{update ? "Tovább az irányítópultra" : "Vissza a bejelentkezéshez"}</Link>
    </div>
  );
  return (
    <form action={action}>
      <FieldGroup>
        {update ? <>
          {/* Shown only when this session did NOT arrive through a recovery email.
              Someone who has forgotten their password cannot be asked for it;
              everyone else must prove they are the account owner and not just
              whoever found the browser signed in. */}
          {requiresCurrentPassword ? (
            <Field>
              <FieldLabel htmlFor="current_password">Jelenlegi jelszó</FieldLabel>
              <Input id="current_password" name="current_password" type="password" autoComplete="current-password" required />
              <FieldDescription>Ha nem emlékszel rá, kérj jelszó-visszaállító e-mailt.</FieldDescription>
            </Field>
          ) : null}
          <Field><FieldLabel htmlFor="password">Új jelszó</FieldLabel><Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></Field>
          <Field><FieldLabel htmlFor="password_confirmation">Új jelszó még egyszer</FieldLabel><Input id="password_confirmation" name="password_confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></Field>
        </> : <Field><FieldLabel htmlFor="email">E-mail cím</FieldLabel><Input id="email" name="email" type="email" autoComplete="email" required /></Field>}
        {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        <Button type="submit" disabled={pending}>{pending ? "Folyamatban…" : update ? "Új jelszó mentése" : "Visszaállító link küldése"}</Button>
        <Link href={update ? "/auth/forgot-password" : "/login"} className="text-sm underline underline-offset-4">{update ? "Új visszaállító linket kérek" : "Vissza a bejelentkezéshez"}</Link>
      </FieldGroup>
    </form>
  );
}
