import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Round-3 finding R3-03. Public route -- whoever clicks the confirmation
 * link may not be signed in to this app at all (a different browser or
 * device than the one that requested the change), the same as this app's
 * existing /auth/confirm flow. Uses the admin client since there's no
 * authenticated session to run this under; confirm_notification_email_change
 * itself is the actual security boundary (a token match, not this route's
 * caller identity) -- see its migration.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (token) {
    const admin = createAdminClient();
    const { data: organizationId, error } = await admin.rpc("confirm_notification_email_change", {
      p_token: token,
    });
    if (!error && organizationId !== null) {
      redirect("/dashboard/settings?notification_email=confirmed");
    }
  }

  redirect("/dashboard/settings?notification_email=invalid");
}
