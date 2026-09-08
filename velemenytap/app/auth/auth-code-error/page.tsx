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
