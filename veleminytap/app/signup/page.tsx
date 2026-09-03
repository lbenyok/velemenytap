import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/auth-shell";
import { SignupForm } from "@/features/auth/signup-form";

export const metadata: Metadata = { title: "Create account — VéleményTap" };

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      description="Start collecting customer feedback with VéleményTap."
    >
      <SignupForm />
    </AuthShell>
  );
}
