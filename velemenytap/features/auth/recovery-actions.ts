"use server";

import { z } from "zod";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { consumeRecoveryPasswordGrant, reissueRecoveryPasswordGrant } from "./recovery-grant";

export type RecoveryState = { error?: string; success?: boolean };
const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(8).max(72);

export async function resendConfirmationAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const email = emailSchema.safeParse(form.get("email"));
  if (!email.success) return { error: "Adj meg egy érvényes e-mail címet." };
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (origin.protocol !== "https:" && !(process.env.NODE_ENV === "development" && origin.hostname === "localhost")) throw new Error("Invalid site URL");
    const client = await createClient();
    const { error } = await client.auth.resend({ type: "signup", email: email.data, options: { emailRedirectTo: `${origin.origin}/auth/confirm?next=/onboarding` } });
    if (error) return { error: "Most nem sikerült új linket kérni. Várj néhány percet, és próbáld újra." };
    return { success: true };
  } catch { return { error: "Most nem sikerült új linket kérni. Kérjük, próbáld újra később." }; }
}

export async function requestPasswordResetAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const email = emailSchema.safeParse(form.get("email"));
  if (!email.success) return { error: "Adj meg egy érvényes e-mail címet." };
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (origin.protocol !== "https:" && !(process.env.NODE_ENV === "development" && origin.hostname === "localhost")) {
      throw new Error("Invalid site URL");
    }
    const client = await createClient();
    const { error } = await client.auth.resetPasswordForEmail(email.data, {
      redirectTo: `${origin.origin}/auth/callback?next=/auth/reset-password`,
    });
    if (error) return { error: "Most nem sikerült elküldeni a kérést. Várj néhány percet, és próbáld újra." };
    // Identical response whether or not an account exists.
    return { success: true };
  } catch {
    return { error: "Most nem sikerült elküldeni a kérést. Kérjük, próbáld újra később." };
  }
}

/**
 * Verifies a password without touching the caller's own session.
 *
 * `signInWithPassword` on the request-bound server client would rewrite the
 * session cookies as a side effect of a check. This is a throwaway client with
 * no persistence, so a wrong guess changes nothing and a right one leaves the
 * existing session exactly as it was.
 *
 * Brute force is bounded by Supabase Auth's own sign-in rate limiter, the same
 * one that protects /login — and the threat model here already assumes the
 * attacker holds the session, so guessing the current password buys them only
 * the change this check exists to stop.
 */
async function currentPasswordIsCorrect(email: string, password: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;
  const probe = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await probe.auth.signInWithPassword({ email, password });
  return !error;
}

/**
 * Whether the provider is telling us the password was rejected on its own
 * policy -- and therefore definitely not applied.
 *
 * GoTrue reports these as 4xx with a stable code. A 5xx, a transport failure or
 * an unrecognised shape is NOT definitive: the update may have succeeded, and
 * treating it as a clean refusal would hand back a fresh grant for an account
 * whose password has already changed.
 */
function isDefinitivePasswordRejection(error: { status?: number; code?: string; message?: string }): boolean {
  const definitiveCodes = new Set([
    "weak_password",
    "same_password",
    "validation_failed",
  ]);
  if (error.code && definitiveCodes.has(error.code)) return true;
  if (typeof error.status === "number" && error.status === 422) return true;
  return false;
}

export async function updatePasswordAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const password = passwordSchema.safeParse(form.get("password"));
  if (!password.success) return { error: "Az új jelszó 8–72 karakter hosszú legyen." };
  if (password.data !== form.get("password_confirmation")) return { error: "A két jelszó nem egyezik." };
  const client = await createClient();
  const { data, error: userError } = await client.auth.getUser();
  if (userError || !data.user) return { error: "A link lejárt. Kérj új jelszó-visszaállító e-mailt." };

  // Having a session is not permission to replace the password on it. An
  // unattended, signed-in browser is the normal case for this product's
  // customers, and a password change is precisely the move that turns borrowed
  // access into permanent access while locking the real owner out. Only a
  // session that arrived through a recovery email minutes ago is excused from
  // proving it knows the current password -- because that flow, by definition,
  // cannot.
  //
  // Round-14 R14-01: that grant is CONSUMED here, not observed. The first
  // version of this guard asked a cookie whether it existed, which a browser's
  // holder can always make true; this asks the database to atomically spend a
  // row bound to this user id, so a forged or replayed cookie gets false and a
  // genuine one works exactly once.
  const fromRecoveryEmail = await consumeRecoveryPasswordGrant(data.user.id);
  if (!fromRecoveryEmail) {
    const currentPassword = form.get("current_password");
    if (typeof currentPassword !== "string" || currentPassword === "") {
      return { error: "Add meg a jelenlegi jelszavad is, vagy kérj jelszó-visszaállító e-mailt." };
    }
    if (!data.user.email || !(await currentPasswordIsCorrect(data.user.email, currentPassword))) {
      return { error: "A megadott jelenlegi jelszó nem helyes." };
    }
  }

  // Round-15 R15-01. The check above is enforced by THIS action, and an
  // attacker at a signed-in browser is under no obligation to use it: the
  // Auth API accepts `updateUser({ password })` from an ordinary session
  // directly. Measured against the isolated project on 2026-09-14 -- the new
  // password worked and the old one stopped. So the application-side guard is
  // a UI-path defence, NOT the security boundary it was described as.
  //
  // The boundary has to be the provider's own, and the provider's own needs
  // the proof forwarded: with "Require current password when changing
  // password" enabled, GoTrue checks `current_password` AT the update
  // endpoint, which is the one place a direct API call cannot skip. Sending it
  // here is also what stops enabling that option from breaking every ordinary
  // password change -- verifying locally and then omitting it would fail at
  // the provider.
  //
  // Not sent on the recovery path: a recovery session by definition does not
  // know the old password, and GoTrue exempts it.
  const currentPasswordProof =
    !fromRecoveryEmail && typeof form.get("current_password") === "string"
      ? { current_password: form.get("current_password") as string }
      : {};

  const { error } = await client.auth.updateUser({ password: password.data, ...currentPasswordProof });
  if (error) {
    // Round-15 R15-02. A definitive validation refusal means the password was
    // NOT changed, so a recovery customer must be able to try another one
    // without a second email -- the previous version spent their grant here and
    // then offered a retry that asked for the password they had forgotten.
    //
    // Deliberately narrow: only refusals the provider states as validation
    // failures qualify. Anything else -- a network error, a timeout, an
    // unrecognised code -- may have changed the password, and re-issuing a
    // grant on an unknown outcome is how replay protection gets given away.
    if (fromRecoveryEmail && isDefinitivePasswordRejection(error)) {
      await reissueRecoveryPasswordGrant(data.user.id);
      return { error: "Ezt a jelszót nem fogadta el a rendszer. Válassz másikat -- a visszaállító linked még érvényes." };
    }
    return {
      error: fromRecoveryEmail
        ? "Nem sikerült menteni a jelszót. Kérj új jelszó-visszaállító e-mailt, és próbáld újra."
        : "Nem sikerült menteni a jelszót. Válassz másik jelszót, vagy próbáld újra.",
    };
  }
  return { success: true };
}
