import { AuthShell } from "@/features/auth/auth-shell";
import { RecoveryForm } from "@/features/auth/recovery-form";

export const metadata = { title: "Elfelejtett jelszó — VéleményTap" };
export default function ForgotPasswordPage() {
  return <AuthShell title="Elfelejtetted a jelszavad?" description="Add meg a fiókod e-mail címét, és kérj egy visszaállító linket."><RecoveryForm /></AuthShell>;
}
