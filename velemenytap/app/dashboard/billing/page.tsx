import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleCheck, Clock, TriangleAlert, Gift, Star, RefreshCw } from "lucide-react";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingActive, hasLiveSubscription, type OrganizationBilling } from "@/features/billing/status";
import { createCheckoutSessionAction, createPortalSessionAction } from "@/features/billing/actions";
import { resyncOrganizationBillingFormAction } from "@/features/billing/admin-actions";
import { reconcileOrganizationBilling, customerIdMatches } from "@/features/billing/reconcile";
import { PLAN_PRICING, type BillingInterval } from "@/features/billing/plans";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Számlázás — VéleményTap" };

const YEARLY_SAVINGS_HUF = PLAN_PRICING.monthly.amountHuf * 12 - PLAN_PRICING.yearly.amountHuf;
const YEARLY_SAVINGS_MONTHS = Math.round(YEARLY_SAVINGS_HUF / PLAN_PRICING.monthly.amountHuf);

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

type CheckoutSuccessState = "none" | "confirmed" | "pending" | "unpaid" | "invalid";

/**
 * Fourth independent review, Finding 12: "organization ownership must not
 * pass merely because ONE of two CONFLICTING identifiers matches." The
 * previous check was an OR -- if client_reference_id and
 * metadata.organization_id disagreed (one forged or stale, one genuine),
 * the mismatch was silently ignored as long as either happened to match.
 * Both, when both are present, must agree; when only one is present, that
 * one alone must match; when neither is present, ownership can't be
 * verified at all.
 */
export function orgIdentifiersAgree(session: Stripe.Checkout.Session, organizationId: number): boolean {
  const orgIdStr = organizationId.toString();
  const ref = session.client_reference_id;
  const meta = session.metadata?.organization_id;
  const refPresent = ref !== null && ref !== undefined;
  const metaPresent = meta !== null && meta !== undefined;
  if (refPresent && metaPresent) return ref === orgIdStr && meta === orgIdStr;
  if (refPresent) return ref === orgIdStr;
  if (metaPresent) return meta === orgIdStr;
  return false;
}

/**
 * Fourth independent review, Finding 7 (checkout=success verification)
 * and Finding 5 (a paying customer must not depend on every webhook
 * eventually arriving): `?checkout=success` alone proves nothing -- Stripe's
 * own `{CHECKOUT_SESSION_ID}` placeholder is verified directly against
 * Stripe and checked to actually belong to THIS organization first.
 *
 * "confirmed" now requires the EXACT session's own subscription to be
 * locally reconciled as active/trialing -- not merely "this organization
 * has SOME live subscription," which could be a different, older one.
 * If it isn't reconciled yet, this ACTIVELY calls the shared
 * reconciliation service right here (rather than only waiting for a
 * webhook that Finding 5 established is not guaranteed to ever arrive) --
 * a page reload is now often enough to self-heal a delayed webhook, not
 * just re-read the same stale row.
 */
export async function resolveCheckoutSuccessState(
  organizationId: number,
  sessionId: string | undefined,
  billing: OrganizationBilling | null,
): Promise<CheckoutSuccessState> {
  if (!sessionId) {
    return "invalid";
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await createStripeClient().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error(`Billing page: failed to retrieve Checkout Session ${sessionId} for organization ${organizationId}:`, err);
    return "invalid";
  }

  if (!orgIdentifiersAgree(session, organizationId)) {
    console.error(
      `Billing page: Checkout Session ${sessionId} identifiers do not agree with organization ${organizationId} ` +
        `(client_reference_id=${session.client_reference_id}, metadata.organization_id=${session.metadata?.organization_id}) -- ignoring.`,
    );
    return "invalid";
  }

  if (session.status !== "complete" || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) {
    return "unpaid";
  }

  const sessionSubscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  const isConfirmed = (b: OrganizationBilling | null) =>
    sessionSubscriptionId != null &&
    b?.stripe_subscription_id === sessionSubscriptionId &&
    (b.status === "active" || b.status === "trialing");

  if (isConfirmed(billing)) {
    return "confirmed";
  }

  if (sessionSubscriptionId) {
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    // Round-12 review, qualified ownership gap. The webhook path checks the
    // Session's Customer against the organization's persisted one before
    // reconciling (customerIdMatches); this path did not, and
    // write_reconciliation_result overwrites stripe_customer_id
    // unconditionally. The identifier check above proves the Session CLAIMS to
    // belong to this organization, not that its Customer does -- so a Session
    // created outside the normal flow carrying this organization's metadata
    // could have bound a foreign Customer and made its subscriptions the
    // entitlement source. Not reachable through ordinary customer use, which
    // always passes the persisted Customer; closed anyway, because "only
    // reachable by an operator" is not an access-control argument.
    if (customerId && !customerIdMatches(billing?.stripe_customer_id ?? null, customerId)) {
      console.error(
        `Billing page: Checkout Session ${sessionId} names customer ${customerId}, but organization ` +
          `${organizationId} is persisted against ${billing?.stripe_customer_id} -- refusing to reconcile.`,
      );
      return "invalid";
    }
    if (customerId) {
      const result = await reconcileOrganizationBilling(organizationId, customerId);
      if (result.outcome === "reconciled" && result.subscriptionId === sessionSubscriptionId && (result.status === "active" || result.status === "trialing")) {
        return "confirmed";
      }
    }
  }

  return "pending";
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
