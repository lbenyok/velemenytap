import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectTarget } from "@/lib/safe-redirect";
import { grantRecoveryPasswordChange } from "@/features/auth/recovery-grant";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeRedirectTarget(searchParams.get("next"));

  if (token_hash && type) {
    const supabase = await createClient();
    const { data: verified, error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      // A recovery link is the one case allowed to set a password without
      // knowing the old one -- see features/auth/recovery-grant.ts. Bound to
      // the user this OTP actually authenticated rather than to whoever holds
      // the session afterwards (round-14 R14-01).
      if (type === "recovery" && verified.user) {
        await grantRecoveryPasswordChange(verified.user.id);
      }
      redirect(next);
    }
  }

  redirect("/auth/auth-code-error");
}
