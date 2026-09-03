"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUpAction, type AuthActionState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";

const initialState: AuthActionState = {};

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(
    signUpAction,
    initialState,
  );

  return (
    <form action={formAction} noValidate>
      <FieldGroup>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="email">E-mail cím</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-invalid={!!state.error}
          />
        </Field>
        <Field data-invalid={!!state.error}>
          <FieldLabel htmlFor="password">Jelszó</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={!!state.error}
          />
          <FieldDescription
            className={state.error ? "text-destructive" : undefined}
          >
            {state.error ?? "Legalább 8 karakter hosszú legyen."}
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Fiók létrehozása..." : "Fiók létrehozása"}
          </Button>
          <FieldDescription>
            Van már fiókod?{" "}
            <Link href="/login" className="underline underline-offset-4">
              Jelentkezz be
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
