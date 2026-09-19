import "server-only";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { reconcileOrganizationBilling, customerIdMatches } from "@/features/billing/reconcile";
import type { OrganizationBilling } from "./status";

export type CheckoutSuccessState = "none" | "confirmed" | "pending" | "unpaid" | "invalid";

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

