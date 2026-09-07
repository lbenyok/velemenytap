import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleCheck, Clock, TriangleAlert, Gift, Star } from "lucide-react";
import { createStripeClient } from "@/lib/stripe";
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

type CheckoutSuccessState = "none" | "confirmed" | "pending" | "unpaid" | "invalid";

/**
 * Second independent review, Finding 7: `?checkout=success` alone must
 * never be treated as proof of payment -- a bookmarked, shared, or
 * hand-crafted URL could carry it with no real Checkout having happened
 * at all. Stripe's `{CHECKOUT_SESSION_ID}` placeholder (substituted with
 * the real session id server-side on redirect -- see
 * features/billing/actions.ts's success_url) is verified here directly
 * against Stripe, and checked to actually belong to THIS organization,
 * before ever rendering a success message. Distinguishes:
 *   - "confirmed": paid, and this organization's own billing state
 *     already reflects it (the subscription webhook has landed).
 *   - "pending": Checkout completed, but reconciliation hasn't landed yet
 *     -- webhooks are asynchronous; this is a normal, brief window, not
 *     an error.
 *   - "unpaid": the session exists but never actually completed/paid
 *     (expired, canceled mid-flow, etc).
 *   - "invalid": no session_id, the session doesn't exist, or it belongs
 *     to a different organization -- logged loudly (a foreign session id
 *     here is worth investigating) and never shown as any kind of success.
 */
async function resolveCheckoutSuccessState(
  organizationId: number,
  sessionId: string | undefined,
  hasSubscriptionNow: boolean,
): Promise<CheckoutSuccessState> {
  if (!sessionId) {
    return "invalid";
  }

  let session;
  try {
    session = await createStripeClient().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error(`Billing page: failed to retrieve Checkout Session ${sessionId} for organization ${organizationId}:`, err);
    return "invalid";
  }

  const belongsToThisOrg =
    session.client_reference_id === organizationId.toString() ||
    session.metadata?.organization_id === organizationId.toString();
  if (!belongsToThisOrg) {
    console.error(
      `Billing page: Checkout Session ${sessionId} does not belong to organization ${organizationId} (client_reference_id=${session.client_reference_id}) -- ignoring.`,
    );
    return "invalid";
  }

  if (session.status !== "complete" || session.payment_status !== "paid") {
    return "unpaid";
  }

  return hasSubscriptionNow ? "confirmed" : "pending";
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
  // hasLiveSubscription, not a bare stripe_subscription_id check -- found
  // during an independent review: a canceled or never-completed
  // (incomplete_expired) subscription must show the Checkout forms again,
  // not the "manage subscription" Portal button for a subscription that
  // no longer meaningfully exists. See features/billing/status.ts.
  const hasSubscription = hasLiveSubscription(billing);
  const grandfathered = billing?.grandfathered_at != null && !hasSubscription;
  const trialing = billing?.status === "trialing" && !hasSubscription && !grandfathered;
  const trialDaysLeft =
    trialing && billing?.trial_ends_at
      ? Math.max(
          0,
          Math.ceil((new Date(billing.trial_ends_at).getTime() - new Date().getTime()) / 86_400_000),
        )
      : null;

  const checkoutSuccess: CheckoutSuccessState =
    sp.checkout === "success" ? await resolveCheckoutSuccessState(organization.id, sp.session_id, hasSubscription) : "none";

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
          <AlertDescription>Ez általában néhány másodpercet vesz igénybe. Frissítsd az oldalt egy pillanat múlva.</AlertDescription>
        </Alert>
      ) : checkoutSuccess === "unpaid" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>A fizetés nem fejeződött be.</AlertTitle>
          <AlertDescription>Nem történt sikeres terhelés. Bármikor újra elindíthatod alább.</AlertDescription>
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
                  ? `A következő számlázás dátuma: ${formatDate(billing.current_period_end)}${billing.cancel_at_period_end ? " (lemondva, ekkor szűnik meg)" : ""}.`
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
