import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/features/auth/auth-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Lejárt link — VéleményTap" };

export default function AuthCodeErrorPage() {
  return (
    <AuthShell
      title="Ez a link már nem működik"
      description="Lehet, hogy lejárt, vagy már felhasználták."
    >
      <Link
        href="/auth/forgot-password"
        className="mb-4 block text-sm underline underline-offset-4"
      >
        Új jelszó-visszaállító linket kérek
      </Link>
      <Link
        href="/signup/check-email"
        className="mb-4 block text-sm underline underline-offset-4"
      >
        Új regisztrációs megerősítő linket kérek
      </Link>
      <Button
        render={<Link href="/login" />}
        nativeButton={false}
        className="w-full"
      >
        Vissza a bejelentkezéshez
      </Button>
    </AuthShell>
  );
}
