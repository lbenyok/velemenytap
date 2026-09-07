import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleCheck, TriangleAlert, Star } from "lucide-react";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive, hasLiveSubscription } from "@/features/billing/status";
import { createCheckoutSessionAction, createPortalSessionAction } from "@/features/billing/actions";
import { PLAN_PRICING, type BillingInterval } from "@/features/billing/plans";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Számlázás — VéleményTap" };

// Éves ár vs. 12x havi ár -- a "kb. 2 hónapot spórolsz" jelvényhez.
const YEARLY_SAVINGS_HUF = PLAN_PRICING.monthly.amountHuf * 12 - PLAN_PRICING.yearly.amountHuf;
const YEARLY_SAVINGS_MONTHS = Math.round(YEARLY_SAVINGS_HUF / PLAN_PRICING.monthly.amountHuf);

const PLAN_FEATURES = [
  "Korlátlan helyszín és NFC kártya",
  // Found during an independent review: "Azonnali e-mail értesítés"
  // (instant email notification) overstated a system with a per-card
  // cooldown, an organization-wide hourly send budget, and possible
  // provider failures -- matching the wording already corrected on the
  // homepage (app/page.tsx) and in the onboarding tour (features/
  // onboarding-tour/tour-steps.ts): conditional ("beállíthatsz" -- you
  // can set up), never a guaranteed-immediate promise.
  "E-mailes értesítést állíthatsz be negatív véleményekhez",
  "Teljes elemzés és trendek",
  "Nincs válogatás — minden vélemény, minden csillag",
];

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("hu-HU", { year: "numeric", month: "long", day: "numeric" }).format(
    new Date(value),
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const sp = await searchParams;
  const billing = await getOrganizationBilling(organization.id);
  const active = isBillingActive(billing);
  // hasLiveSubscription, not a bare stripe_subscription_id check -- found
  // during an independent review: a canceled or never-completed
  // (incomplete_expired) subscription must show the Checkout forms again,
  // not the "manage subscription" Portal button for a subscription that
  // no longer meaningfully exists. See features/billing/status.ts.
  const hasSubscription = hasLiveSubscription(billing);
  const trialing = billing?.status === "trialing" && !hasSubscription;
  const trialDaysLeft =
    trialing && billing?.trial_ends_at
      ? Math.max(
          0,
          Math.ceil((new Date(billing.trial_ends_at).getTime() - new Date().getTime()) / 86_400_000),
        )
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
          Számlázás
        </h1>
        <p className="text-sm text-muted-foreground">
          Kezeld az előfizetésedet és a számlázási adataidat.
        </p>
      </div>

      {sp.checkout === "success" ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>Sikeres előfizetés.</AlertTitle>
          <AlertDescription>Köszönjük — az irányítópult mostantól elérhető.</AlertDescription>
        </Alert>
      ) : sp.checkout === "canceled" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>A fizetés megszakadt.</AlertTitle>
          <AlertDescription>Nem történt terhelés. Bármikor újra elindíthatod alább.</AlertDescription>
        </Alert>
      ) : sp.error === "checkout_failed" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Nem sikerült elindítani a fizetést.</AlertTitle>
          <AlertDescription>Kérjük, próbáld újra, vagy írj nekünk, ha a hiba ismétlődik.</AlertDescription>
        </Alert>
      ) : sp.error === "portal_failed" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Nem sikerült megnyitni a számlázási felületet.</AlertTitle>
          <AlertDescription>Kérjük, próbáld újra egy pillanat múlva.</AlertDescription>
        </Alert>
      ) : sp.error === "no_subscription" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Még nincs aktív előfizetésed.</AlertTitle>
          <AlertDescription>Először fizess elő alább — utána bármikor kezelheted itt.</AlertDescription>
        </Alert>
      ) : sp.error === "already_subscribed" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Már van előfizetésed.</AlertTitle>
          <AlertDescription>Az előfizetésed kezeléséhez használd a lenti gombot.</AlertDescription>
        </Alert>
      ) : sp.error === "unauthorized" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Nincs jogosultságod a számlázás kezeléséhez.</AlertTitle>
          <AlertDescription>Ehhez tulajdonosi vagy admin szerepkör szükséges — kérd meg a szervezet tulajdonosát.</AlertDescription>
        </Alert>
      ) : null}

      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>VéleményTap előfizetés</CardTitle>
            {active ? (
              <Badge>{trialing ? "Próbaidőszak" : "Aktív"}</Badge>
            ) : (
              <Badge variant="destructive">Nincs aktív előfizetés</Badge>
            )}
          </div>
          <CardDescription>
            {trialing && trialDaysLeft !== null
              ? `${trialDaysLeft} nap van hátra az ingyenes próbaidőszakból.`
              : active && billing?.current_period_end
                ? `A következő számlázás dátuma: ${formatDate(billing.current_period_end)}${billing.cancel_at_period_end ? " (lemondva, ekkor szűnik meg)" : ""}.`
                : "Fizess elő, hogy folytathasd az irányítópult használatát."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ul className="space-y-2">
            {PLAN_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-foreground">
                <Star className="mt-0.5 size-3.5 shrink-0 text-primary" strokeWidth={2} />
                {feature}
              </li>
            ))}
          </ul>

          {hasSubscription ? (
            <form action={createPortalSessionAction}>
              <Button type="submit" variant="outline" className="w-full sm:w-auto">
                Előfizetés kezelése
              </Button>
            </form>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <PlanOption interval="monthly" />
              <PlanOption interval="yearly" savingsMonths={YEARLY_SAVINGS_MONTHS} />
            </div>
          )}

          <p className="text-xs text-muted-foreground">Az árak az ÁFát tartalmazzák.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function PlanOption({ interval, savingsMonths }: { interval: BillingInterval; savingsMonths?: number }) {
  const plan = PLAN_PRICING[interval];
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        interval === "yearly" ? "border-primary" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{plan.label}</span>
        {savingsMonths ? (
          <Badge variant="secondary">kb. {savingsMonths} hónap ingyen</Badge>
        ) : null}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="text-2xl font-medium tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {plan.amountHuf.toLocaleString("hu-HU")} Ft
        </span>
        <span className="text-sm text-muted-foreground">/ {plan.cadence}</span>
      </div>
      <form action={createCheckoutSessionAction}>
        <input type="hidden" name="interval" value={interval} />
        <Button
          type="submit"
          variant={interval === "yearly" ? "default" : "outline"}
          className="w-full"
        >
          Előfizetek
        </Button>
      </form>
    </div>
  );
}
