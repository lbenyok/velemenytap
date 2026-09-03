import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { SettingsForm } from "@/features/organizations/settings-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata: Metadata = { title: "Beállítások — VéleményTap" };

export default async function SettingsPage() {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("name, notification_email, logo_url")
    .eq("id", organization.id)
    .single();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Beállítások</h1>
        <p className="text-sm text-muted-foreground">
          Kezeld a vállalkozásod profilját és az értesítési beállításokat.
        </p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Vállalkozás profilja</CardTitle>
          <CardDescription>
            Ezek az adatok az irányítópultodon és a nyilvános vélemény
            oldalakon is megjelennek.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            organization={{
              name: org?.name ?? organization.name,
              notification_email: org?.notification_email ?? null,
              logo_url: org?.logo_url ?? null,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
