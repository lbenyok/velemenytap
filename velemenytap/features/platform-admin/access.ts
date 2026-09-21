import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Fresh Auth lookup + server-managed UID membership, never user_metadata or email. */
export async function getPlatformAdmin() {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user || !user.email_confirmed_at) return null;
  const { data, error: membershipError } = await client
    .from("platform_admins").select("user_id, role").eq("user_id", user.id).maybeSingle();
  if (membershipError) throw new Error("Az adminisztrátori jogosultság nem ellenőrizhető.");
  return data ? { ...user, platformRole: data.role as "owner" | "moderator" } : null;
}
