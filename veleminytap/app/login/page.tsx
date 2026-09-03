import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/features/auth/auth-shell";
import { LoginForm } from "@/features/auth/login-form";

export const metadata: Metadata = { title: "Sign in — VéleményTap" };

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      description="Sign in to your VéleményTap dashboard."
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
