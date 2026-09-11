import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectTarget } from "@/lib/safe-redirect";

/**
 * Completes an emailed auth link (password recovery, and any other link
 * pointed here) and lands the user on `next`.
 *
 * Supabase can deliver such a link in more than one shape, and which one
 * arrives depends on the project's email templates and on whether the
 * request that generated it registered a PKCE challenge -- neither of which
 * this route controls:
 *
 *   * `?code=...`            -- PKCE. Exchanged for a session here.
 *   * `?token_hash=&type=`   -- the OTP shape Supabase's own Next.js guide
 *                               recommends templates use. `/auth/confirm`
 *                               already handles it for signup confirmation;
 *                               accepting it here too means a recovery
 *                               template written either way still works.
 *   * `#access_token=...`    -- the implicit fallback. A fragment is never
 *                               sent to the server, so no route handler can
 *                               read it; this one degrades to the error page
 *                               rather than appearing to hang.
 *
 * Handling both server-readable shapes was added after a real recovery link
 * generated against the isolated project came back in the implicit shape and
 * dead-ended here -- see STATUS.md. It costs three lines and removes one of
 * the two ways this flow can fail entirely.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeRedirectTarget(params.get("next"));

  const code = params.get("code");
  if (code) {
    const client = await createClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) redirect(next);
  }

  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  if (tokenHash && type) {
    const client = await createClient();
    const { error } = await client.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect(next);
  }

  redirect("/auth/auth-code-error");
}
