import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/auth-shell";
import { RecoveryForm } from "@/features/auth/recovery-form";
import { hasRecoveryPasswordGrant } from "@/features/auth/recovery-grant";

export const metadata = { title: "Új jelszó — VéleményTap" };

// This page's output depends on a cookie -- whether the current-password field
// is rendered at all -- so it must never be served from a cached render. It was
// observed serving the no-field variant to a session that had no grant, which
// is how the recovery marker became visible as a caching question rather than
// an auth one. The Server Action re-checks the grant independently, so a stale
// render was never a way to actually change a password; it was a way to be
// shown a form that would then refuse.
export const dynamic = "force-dynamic";
export default async function ResetPasswordPage() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/auth/forgot-password");
  // A session alone is not permission to replace the password on it -- see
  // features/auth/recovery-grant.ts. The action re-checks this independently;
  // this only decides whether to render the field.
  const fromRecoveryEmail = await hasRecoveryPasswordGrant(data.user.id);
  return (
    <AuthShell
      title="Adj meg új jelszót"
      description={fromRecoveryEmail ? "Legalább 8 karakterből álló, egyedi jelszót válassz." : "A biztonság kedvéért add meg a jelenlegi jelszavad is."}
    >
      <RecoveryForm update requiresCurrentPassword={!fromRecoveryEmail} />
    </AuthShell>
  );
}
