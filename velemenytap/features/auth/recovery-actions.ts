"use server";

import { z } from "zod";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { consumeRecoveryPasswordGrant } from "./recovery-grant";

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

  const { error } = await client.auth.updateUser({ password: password.data });
  if (error) return { error: "Nem sikerült menteni a jelszót. Válassz másik jelszót, vagy kérj új visszaállító linket." };
  return { success: true };
}
