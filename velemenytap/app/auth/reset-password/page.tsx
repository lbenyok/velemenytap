import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/auth-shell";
import { RecoveryForm } from "@/features/auth/recovery-form";

export const metadata = { title: "Új jelszó — VéleményTap" };
export default async function ResetPasswordPage() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/auth/forgot-password");
  return <AuthShell title="Adj meg új jelszót" description="Legalább 8 karakterből álló, egyedi jelszót válassz."><RecoveryForm update /></AuthShell>;
}
