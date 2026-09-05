"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectTarget } from "@/lib/safe-redirect";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive } from "@/features/billing/status";

export type AuthActionState = { error: string } | { error?: undefined };

const emailPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Adj meg egy érvényes e-mail címet."),
  password: z
    .string()
    .min(8, "A jelszónak legalább 8 karakter hosszúnak kell lennie.")
    .max(72, "A jelszó legfeljebb 72 karakter lehet."),
});

/**
 * Supabase Auth's own errors (error.message below) come back in English
 * from the SDK -- there's no way to request a localized message from it.
 * This maps the ones users actually hit to Hungarian; anything unmapped
 * falls back to a generic message rather than showing raw English.
 */
function translateAuthError(message: string): string {
  const known: Record<string, string> = {
    "Invalid login credentials": "Hibás e-mail cím vagy jelszó.",
    "User already registered": "Ez az e-mail cím már regisztrálva van.",
    "Email not confirmed": "Az e-mail címed még nincs megerősítve. Nézd meg a postaládádat.",
    "Signup requires a valid password": "Adj meg egy érvényes jelszót.",
  };
  if (known[message]) return known[message];
  if (message.toLowerCase().includes("password")) {
    return "Probléma van a jelszóval. Ellenőrizd, és próbáld újra.";
  }
  if (message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("security purposes")) {
    return "Túl sok próbálkozás történt. Kérjük, várj egy kicsit, majd próbáld újra.";
  }
  return "Hiba történt. Kérjük, próbáld újra.";
}

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = emailPasswordSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Érvénytelen adat." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm?next=/onboarding`,
    },
  });

  if (error) {
    return { error: translateAuthError(error.message) };
  }

  redirect("/signup/check-email");
}

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = emailPasswordSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Add meg az e-mail címed és a jelszavad." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: translateAuthError(error.message) };
  }

  const target = safeRedirectTarget(formData.get("next"));

  // Resolve the billing paywall's target directly here rather than
  // letting app/dashboard/layout.tsx redirect a second time on its own
  // render -- two server-side redirect()s chained through one Server
  // Action response is a genuine, reproducible Turbopack dev-mode bug
  // (the client's RSC-payload fetch for the second hop fails with a
  // connection reset -- "Failed to fetch RSC payload... falling back to
  // browser navigation" -- and the fallback can itself retrigger the same
  // failure, producing a real client-side reload loop, confirmed directly
  // via browser console during this feature's own e2e verification). A
  // single redirect straight to the correct destination sidesteps the
  // chain entirely; the layout's own check remains the actual security
  // boundary for every other dashboard entry point (direct navigation,
  // bookmarks, etc.), just not the one this specific race was found on.
  if (target === "/dashboard" || target.startsWith("/dashboard/")) {
    if (target !== "/dashboard/billing" && !target.startsWith("/dashboard/billing/")) {
      const organization = await getCurrentOrganization();
      if (organization) {
        const billing = await getOrganizationBilling(organization.id);
        if (!isBillingActive(billing)) {
          redirect("/dashboard/billing");
        }
      }
    }
  }

  redirect(target);
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
