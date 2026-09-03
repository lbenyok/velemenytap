import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/auth-shell";

export const metadata: Metadata = { title: "Erősítsd meg az e-mail címed — VéleményTap" };

export default function CheckEmailPage() {
  return (
    <AuthShell
      title="Nézd meg az e-mailjeidet"
      description="Küldtünk egy megerősítő linket. Kattints rá a fiókod aktiválásához, és kezdj bele."
    >
      <p className="text-center text-sm text-muted-foreground">
        Nem kaptad meg az e-mailt? Nézd meg a spam mappát, vagy próbálj újra
        regisztrálni néhány perc múlva.
      </p>
    </AuthShell>
  );
}
