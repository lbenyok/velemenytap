import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/auth-shell";
import { SignupForm } from "@/features/auth/signup-form";

export const metadata: Metadata = { title: "Fiók létrehozása — VéleményTap" };

export default function SignupPage() {
  return (
    <AuthShell
      title="Hozd létre a fiókodat"
      description="Kezdj el vásárlói véleményeket gyűjteni a VéleményTap segítségével."
    >
      <SignupForm />
    </AuthShell>
  );
}
