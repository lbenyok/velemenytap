import { resolveCheckoutSuccessState, type CheckoutSuccessState } from "@/features/billing/checkout-success";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleCheck, Clock, TriangleAlert, Gift, Star, RefreshCw } from "lucide-react";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive, hasLiveSubscription } from "@/features/billing/status";
import { createCheckoutSessionAction, createPortalSessionAction } from "@/features/billing/actions";
import { resyncOrganizationBillingFormAction } from "@/features/billing/admin-actions";
import { PLAN_PRICING, type BillingInterval } from "@/features/billing/plans";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Számlázás — VéleményTap" };

const PLAN_FEATURES = [
  "Korlátlan helyszín és NFC kártya",
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
  searchParams: Promise<{ checkout?: string; session_id?: string; error?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const sp = await searchParams;
  const billing = await getOrganizationBilling(organization.id);
  const active = isBillingActive(billing);
  const hasSubscription = hasLiveSubscription(billing);
  // Fourth independent review, Finding 12: grandfathered UI requires
  // activated_at to remain null -- an organization that was grandfathered
  // but has since genuinely paid (even if it later canceled) must never
  // be shown "permanently free" messaging again.
  const grandfathered = billing?.grandfathered_at != null && billing?.activated_at == null && !hasSubscription;
  const trialing = billing?.status === "trialing" && !hasSubscription && !grandfathered;
  const trialDaysLeft =
    trialing && billing?.trial_ends_at
      ? Math.max(
          0,
          Math.ceil((new Date(billing.trial_ends_at).getTime() - new Date().getTime()) / 86_400_000),
        )
      : null;

  const checkoutSuccess: CheckoutSuccessState =
    sp.checkout === "success" ? await resolveCheckoutSuccessState(organization.id, sp.session_id, billing) : "none";

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

      {checkoutSuccess === "confirmed" ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>Sikeres előfizetés.</AlertTitle>
          <AlertDescription>Köszönjük — az irányítópult mostantól elérhető.</AlertDescription>
        </Alert>
      ) : checkoutSuccess === "pending" ? (
        <Alert>
          <Clock />
          <AlertTitle>A fizetés megtörtént, feldolgozás alatt.</AlertTitle>
          <AlertDescription>
            Ez általában néhány másodpercet vesz igénybe. Frissítsd az oldalt egy pillanat múlva, vagy használd a lenti
            &bdquo;Frissítés a Stripe alapján&rdquo; gombot.
          </AlertDescription>
        </Alert>
      ) : checkoutSuccess === "unpaid" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>A fizetés nem fejeződött be.</AlertTitle>
          <AlertDescription>A Stripe még nem igazolta a fizetés befejezését. Ha már fizettél, várj, majd frissítsd az állapotot; ne indíts új fizetést csak emiatt.</AlertDescription>
        </Alert>
      ) : sp.checkout === "canceled" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>A fizetés megszakadt.</AlertTitle>
          <AlertDescription>Visszatértél a fizetési oldalról. Ellenőrizd az előfizetés állapotát; a visszatérés önmagában nem igazolja, hogy történt-e terhelés.</AlertDescription>
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
            {grandfathered ? (
              <Badge variant="secondary">Ingyenes hozzáférés</Badge>
            ) : active ? (
              <Badge>{trialing ? "Próbaidőszak" : "Aktív"}</Badge>
            ) : (
              <Badge variant="destructive">Nincs aktív előfizetés</Badge>
            )}
          </div>
          <CardDescription>
            {grandfathered
              ? "A fiókod díjmentes, korlátlan hozzáférést kapott — nincs lejárati dátum, és nem szükséges előfizetned."
              : trialing && trialDaysLeft !== null
                ? `${trialDaysLeft} nap van hátra az ingyenes próbaidőszakból.`
                : active && billing?.current_period_end
                  ? // A Hungarian formatted date already ends in a period
                    // ("2026. október 8."), so the sentence must not add a
                    // second one -- found in the real Stripe test-mode run,
                    // which rendered "2026. október 8..".
                    `A következő számlázás dátuma: ${formatDate(billing.current_period_end)}${billing.cancel_at_period_end ? " (lemondva, ekkor szűnik meg)." : ""}`
                  : "Fizess elő, hogy folytathasd az irányítópult használatát."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {grandfathered ? (
            <Alert>
              <Gift />
              <AlertTitle>Nem kell előfizetned.</AlertTitle>
              <AlertDescription>
                A fiókodat korábban díjmentes, nem lejáró hozzáféréssel jelöltük meg. Ha mégis szeretnél előfizetni (pl. számlázási igazolás miatt), az alábbi lehetőségek bármikor elérhetők.
              </AlertDescription>
            </Alert>
          ) : null}

          <ul className="space-y-2">
            {PLAN_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-foreground">
                <Star className="mt-0.5 size-3.5 shrink-0 text-primary" strokeWidth={2} />
                {feature}
              </li>
            ))}
          </ul>

          {hasSubscription ? (
            <div className="flex flex-wrap gap-2">
              <form action={createPortalSessionAction}>
                <Button type="submit" variant="outline" className="w-full sm:w-auto">
                  Előfizetés kezelése
                </Button>
              </form>
              <form action={resyncOrganizationBillingFormAction}>
                <Button type="submit" variant="ghost" className="w-full sm:w-auto">
                  <RefreshCw data-icon="inline-start" />
                  Frissítés a Stripe alapján
                </Button>
              </form>
            </div>
          ) : (
            <form action={createCheckoutSessionAction} className="flex flex-col gap-4">
              <fieldset className="grid gap-4 sm:grid-cols-2">
                <legend className="sr-only">Fizetési gyakoriság</legend>
                <PlanOption interval="monthly" defaultChecked />
                <PlanOption interval="yearly" />
              </fieldset>
              <Button type="submit" className="w-full sm:w-auto">
                Előfizetek
              </Button>
            </form>
          )}

          <p className="text-xs text-muted-foreground">Az árak az ÁFát tartalmazzák.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The highlight follows whichever option is CHECKED.
 *
 * It used to be hardcoded -- `interval === "yearly" ? "border-primary" : ...`
 * -- so the yearly card was outlined permanently and nothing moved when you
 * picked the other one. Two cards, each with its own form and its own submit
 * button, dressed to look like a chooser: it read as a selection state while
 * being a static emphasis, which is exactly why it looked broken.
 *
 * Now there is one form, one submit button, and a real radio per option. The
 * highlight is Tailwind's `peer-checked:`, not useState -- so this stays a
 * Server Component, and the choice still submits correctly if JavaScript never
 * loads. `sr-only` hides the radio visually without hiding it from assistive
 * tech or the keyboard: arrow keys move between options and the focus ring is
 * carried by the card.
 */
function PlanOption({
  interval,
  defaultChecked,
}: {
  interval: BillingInterval;
  defaultChecked?: boolean;
}) {
  const plan = PLAN_PRICING[interval];
  return (
    <label className="cursor-pointer">
      <input
        type="radio"
        name="interval"
        value={interval}
        defaultChecked={defaultChecked}
        className="peer sr-only"
      />
      <div className="flex h-full flex-col gap-3 rounded-xl border border-border p-4 transition-colors peer-checked:border-primary peer-checked:bg-primary/5 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
        <span className="text-sm font-medium">{plan.label}</span>
        <div className="flex items-baseline gap-1">
          <span
            className="text-2xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {plan.amountHuf.toLocaleString("hu-HU")} Ft
          </span>
          <span className="text-sm text-muted-foreground">/ {plan.cadence}</span>
        </div>
      </div>
    </label>
  );
}
