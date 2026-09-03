import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard — VéleményTap" };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: membership } = await supabase
    .from("organization_memberships")
    .select("role, organizations(name)")
    .limit(1)
    .maybeSingle();

  const orgName = membership?.organizations?.name ?? "your business";

  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">
        Welcome to {orgName}
      </h1>
      <p className="text-sm text-muted-foreground">
        Locations, NFC cards, and the feedback inbox land here next.
      </p>
    </div>
  );
}
