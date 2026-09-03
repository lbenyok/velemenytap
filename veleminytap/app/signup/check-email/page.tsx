import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/auth-shell";

export const metadata: Metadata = { title: "Check your email — VéleményTap" };

export default function CheckEmailPage() {
  return (
    <AuthShell
      title="Check your email"
      description="We sent you a confirmation link. Click it to activate your account and get started."
    >
      <p className="text-center text-sm text-muted-foreground">
        Didn&apos;t get an email? Check your spam folder, or try signing up
        again in a few minutes.
      </p>
    </AuthShell>
  );
}
