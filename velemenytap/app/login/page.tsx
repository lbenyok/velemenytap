import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/features/auth/auth-shell";
import { LoginForm } from "@/features/auth/login-form";

export const metadata: Metadata = { title: "Bejelentkezés — VéleményTap" };

export default function LoginPage() {
  return (
    <AuthShell
      title="Bejelentkezés"
      description="Jelentkezz be a VéleményTap irányítópultodra."
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
