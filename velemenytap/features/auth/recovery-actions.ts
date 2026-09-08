"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

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

export async function updatePasswordAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const password = passwordSchema.safeParse(form.get("password"));
  if (!password.success) return { error: "Az új jelszó 8–72 karakter hosszú legyen." };
  if (password.data !== form.get("password_confirmation")) return { error: "A két jelszó nem egyezik." };
  const client = await createClient();
  const { data, error: userError } = await client.auth.getUser();
  if (userError || !data.user) return { error: "A link lejárt. Kérj új jelszó-visszaállító e-mailt." };
  const { error } = await client.auth.updateUser({ password: password.data });
  if (error) return { error: "Nem sikerült menteni a jelszót. Válassz másik jelszót, vagy kérj új visszaállító linket." };
  return { success: true };
}
