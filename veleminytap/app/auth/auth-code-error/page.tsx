import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/features/auth/auth-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Link expired — VéleményTap" };

export default function AuthCodeErrorPage() {
  return (
    <AuthShell
      title="This link no longer works"
      description="It may have expired or already been used."
    >
      <Button
        render={<Link href="/login" />}
        nativeButton={false}
        className="w-full"
      >
        Back to sign in
      </Button>
    </AuthShell>
  );
}
