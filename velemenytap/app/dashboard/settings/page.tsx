import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrganization } from "@/features/organizations/current";
import { SettingsForm } from "@/features/organizations/settings-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { CircleCheck, TriangleAlert } from "lucide-react";

export const metadata: Metadata = { title: "Beállítások — VéleményTap" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notification_email?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const sp = await searchParams;

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select(
      "name, notification_email, notification_email_pending, notification_email_pending_expires_at, logo_url",
    )
    .eq("id", organization.id)
    .single();

  const pendingStillValid =
    !!org?.notification_email_pending &&
    !!org.notification_email_pending_expires_at &&
    new Date(org.notification_email_pending_expires_at) > new Date();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
          Beállítások
        </h1>
        <p className="text-sm text-muted-foreground">
          Kezeld a vállalkozásod profilját és az értesítési beállításokat.
        </p>
      </div>

      {/* R3-03: confirming/rejecting a notification-email confirmation
          link lands back here with this query param, since the confirm
          route itself has no session context to render a page against. */}
      {sp.notification_email === "confirmed" ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>Az e-mail cím megerősítve.</AlertTitle>
          <AlertDescription>
            Mostantól ide érkeznek a negatív vélemény-értesítések.
          </AlertDescription>
        </Alert>
      ) : sp.notification_email === "invalid" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>A megerősítő link érvénytelen vagy lejárt.</AlertTitle>
          <AlertDescription>
            Kérj egy új megerősítést az e-mail cím újbóli megadásával lent.
          </AlertDescription>
        </Alert>
      ) : null}

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
            pendingNotificationEmail={pendingStillValid ? org!.notification_email_pending : null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
