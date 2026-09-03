import type { Metadata } from "next";
import { getCurrentOrganization } from "@/features/organizations/current";

export const metadata: Metadata = { title: "Dashboard — VéleményTap" };

export default async function DashboardPage() {
  const organization = await getCurrentOrganization();

  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">
        Welcome to {organization?.name ?? "your business"}
      </h1>
      <p className="text-sm text-muted-foreground">
        NFC cards and the feedback inbox land here next.
      </p>
    </div>
  );
}
