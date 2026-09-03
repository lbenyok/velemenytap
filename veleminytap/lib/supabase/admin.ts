import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Server-only client using the secret key, which bypasses RLS entirely.
 * Only use this for privileged operations that have already checked
 * authentication/authorization themselves (e.g. creating the first
 * owner membership for a brand-new organization). Never import this
 * from a Client Component.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
