import { type NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveExpectedLivemode, approvedPriceIds } from "@/features/billing/stripe-config";
import {
  reconcileOrganizationBilling,
  activateOrganizationBilling,
  customerIdMatches,
  subscriptionPriceId,
  recordAnomaly,
} from "@/features/billing/reconcile";

/**
 * Fourth independent review, Finding 6: fail closed, not open, on an
 * unrecognized deployment identity. See stripe-config.ts's
 * resolveExpectedLivemode for the full reasoning -- this route treats its
 * thrown error the same way a genuine event.livemode mismatch is treated
 * (HTTP 400, never processed), rather than letting an unhandled exception
 * crash the route with a 500 (which Stripe would just retry forever
 * against the same misconfiguration).
 */
function checkEventEnvironment(event: Stripe.Event): { ok: true } | { ok: false; error: string } {
  let livemode: ReturnType<typeof resolveExpectedLivemode>;
  try {
    livemode = resolveExpectedLivemode();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (livemode.isLocalDev) {
    return { ok: true };
  }
  if (event.livemode !== livemode.expected) {
    return {
      ok: false,
      error:
        `Refusing to process Stripe event ${event.id}: event.livemode is ${event.livemode} but this runtime expects ` +
        `livemode ${livemode.expected}. A test-mode event reaching this environment, or a live-mode event reaching a ` +
        "non-production one, must never be applied.",
    };
  }
  return { ok: true };
}

/**
 * Stripe webhook endpoint. Public by necessity (Stripe's servers call this
 * with no session at all) -- the signature check below is the actual
 * security boundary, not proxy.ts's auth gate. See proxy.ts's PUBLIC_PATHS.
 *
 * All actual reconciliation logic -- picking the organization's current
 * subscription, applying it, and the exclusive lease that makes concurrent
 * reconciliation attempts mutually exclusive rather than racing -- lives
 * in features/billing/reconcile.ts, the one shared service this route,
 * the checkout-success page, the self-service repair action, and the
 * scheduled sweep all call (fourth independent review, Finding 5). This
 * route's own job is narrower: verify the signature and environment,
 * resolve which organization an event is about, verify its Stripe
 * Customer actually matches that organization's own persisted one before
 * ever calling the shared service (Finding 11), and translate the
 * service's outcome into the right HTTP response for Stripe's retry
 * behavior.
 */
export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  const body = await request.text();
  const stripe = createStripeClient();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const environmentCheck = checkEventEnvironment(event);
  if (!environmentCheck.ok) {
    console.error(environmentCheck.error);
    return NextResponse.json({ error: environmentCheck.error }, { status: 400 });
  }

  const admin = createAdminClient();

  let handled = true;
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = (event.data.object as Stripe.Subscription).id;
      handled = await syncSubscription(stripe, admin, subscriptionId);
      break;
    }
    case "invoice.paid": {
      handled = await activateOnPayment(stripe, admin, event.data.object as Stripe.Invoice);
      break;
    }
    default:
      break;
  }

  if (!handled) {
    return NextResponse.json({ error: "failed to apply event" }, { status: 500 });
  }

  const { error: insertError } = await admin.from("stripe_webhook_events").insert({ id: event.id });
  if (insertError && insertError.code !== "23505") {
    return NextResponse.json({ error: "failed to record event" }, { status: 500 });
  }

  return NextResponse.json({ received: true, duplicate: insertError?.code === "23505" });
}

/**
 * Resolves which organization an event is about, verifies its Stripe
 * Customer against that organization's own persisted customer id (Finding
 * 11 -- a mismatch is quarantined, never treated as license to rebind the
 * organization to a different customer), then delegates the actual
 * reconciliation to the shared service.
 */
async function syncSubscription(
  stripe: Stripe,
  admin: ReturnType<typeof createAdminClient>,
  subscriptionId: string,
): Promise<boolean> {
  let eventSubscription: Stripe.Subscription;
  try {
    eventSubscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(
      `Failed to retrieve canonical state for Stripe subscription ${subscriptionId}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  const organizationId = await resolveOrganizationId(admin, eventSubscription);
  if (organizationId === null) {
    console.error(
      `Could not resolve an organization for Stripe subscription ${eventSubscription.id} -- no metadata.organization_id and no matching stripe_customer_id`,
    );
    return false;
  }

  const customerId =
    typeof eventSubscription.customer === "string" ? eventSubscription.customer : eventSubscription.customer.id;

  const { data: orgRow, error: readError } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readError) {
    console.error(`Failed to read organization_billing for organization ${organizationId}: ${readError.message}`);
    return false;
  }
  if (!orgRow) {
    console.error(
      `organization_billing has no row for organization ${organizationId} -- cannot sync Stripe subscription ${eventSubscription.id}`,
    );
    return false;
  }
  if (!customerIdMatches(orgRow.stripe_customer_id, customerId)) {
    console.error(
      `Refusing to sync organization ${organizationId}: its persisted Stripe customer (${orgRow.stripe_customer_id}) ` +
        `does not match subscription ${eventSubscription.id}'s customer (${customerId}) -- quarantined, not applied.`,
    );
    await recordAnomaly(admin, organizationId, "customer_mismatch", {
      persistedCustomerId: orgRow.stripe_customer_id,
      observedCustomerId: customerId,
      subscriptionId: eventSubscription.id,
    });
    return false;
  }

  const result = await reconcileOrganizationBilling(organizationId, customerId);
  if (result.outcome === "error") {
    console.error(`Reconciliation failed for organization ${organizationId}: ${result.message}`);
    return false;
  }
  if (result.outcome === "deferred") {
    // Another reconciler currently owns this organization's lease, or took
    // it away before this attempt could write -- durably marked dirty by
    // the database function itself. Asking Stripe to retry is a fast-path
    // on top of that durable guarantee, not the only thing this depends on.
    console.log(`Organization ${organizationId}: reconciliation deferred (lease contention) -- will retry.`);
    return false;
  }
  if (result.outcome === "no_subscriptions") {
    console.error(`Organization ${organizationId}: Stripe reports no approved subscriptions for customer ${customerId}`);
    return false;
  }
  return true;
}

/**
 * Finding 5/11: sets the one-way "this organization's billing has
 * genuinely, actually been paid for" fact from a signed `invoice.paid`
 * event -- the only durable, verified payment-success signal this
 * handler trusts for activation. Requires the invoice's own Customer to
 * match the organization's persisted one AND the underlying subscription
 * to carry an approved VéleményTap Price before ever activating -- a
 * mismatched invoice must never set activated_at.
 */
async function activateOnPayment(
  stripe: Stripe,
  admin: ReturnType<typeof createAdminClient>,
  invoice: Stripe.Invoice,
): Promise<boolean> {
  if (invoice.parent?.type !== "subscription_details") {
    return true;
  }
  if (invoice.status !== "paid") {
    console.error(`invoice.paid event for invoice ${invoice.id} but its status is "${invoice.status}", not "paid" -- not activating.`);
    return true;
  }

  const organizationId = await resolveOrganizationIdForInvoice(admin, invoice);
  if (organizationId === null) {
    console.error(
      `Could not resolve an organization for Stripe invoice ${invoice.id} -- no subscription metadata snapshot and no matching stripe_customer_id`,
    );
    return false;
  }

  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) {
    console.error(`Stripe invoice ${invoice.id} has no customer id -- cannot verify identity, not activating.`);
    return false;
  }

  const { data: orgRow, error: readError } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readError) {
    console.error(`Failed to read organization_billing for organization ${organizationId}: ${readError.message}`);
    return false;
  }
  if (!orgRow) {
    console.error(`organization_billing has no row for organization ${organizationId} -- cannot activate from invoice ${invoice.id}`);
    return false;
  }
  if (!customerIdMatches(orgRow.stripe_customer_id, customerId)) {
    console.error(
      `Refusing to activate organization ${organizationId} from invoice ${invoice.id}: persisted customer ` +
        `(${orgRow.stripe_customer_id}) does not match invoice customer (${customerId}) -- quarantined.`,
    );
    await recordAnomaly(admin, organizationId, "customer_mismatch", {
      persistedCustomerId: orgRow.stripe_customer_id,
      observedCustomerId: customerId,
      invoiceId: invoice.id,
    });
    return false;
  }

  const subscriptionRef = invoice.parent.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id;
  if (!subscriptionId) {
    console.error(`Invoice ${invoice.id} has no subscription reference -- cannot verify the plan, not activating.`);
    return false;
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(`Failed to retrieve subscription ${subscriptionId} for invoice ${invoice.id}: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  const priceId = subscriptionPriceId(subscription);
  if (!priceId || !approvedPriceIds().has(priceId)) {
    console.error(
      `Invoice ${invoice.id}'s subscription ${subscriptionId} does not carry an approved VéleményTap Price (got ${priceId}) -- not activating.`,
    );
    await recordAnomaly(admin, organizationId, "unapproved_subscription", { subscriptionId, priceId, invoiceId: invoice.id });
    return true;
  }

  const result = await activateOrganizationBilling(organizationId);
  if (result.outcome === "error") {
    console.error(`Activation failed for organization ${organizationId}: ${result.message}`);
    return false;
  }
  if (result.outcome === "deferred") {
    console.log(`Organization ${organizationId}: activation deferred (lease contention) -- will retry.`);
    return false;
  }
  return true;
}

/**
 * organization_id travels as Stripe subscription metadata, set once at
 * Checkout Session creation (features/billing/actions.ts's
 * subscription_data.metadata) -- Stripe carries it forward onto every
 * subsequent event for that subscription, including ones triggered from
 * the customer-facing Billing Portal rather than this app's own code.
 * Falls back to looking the org up by its already-linked Stripe customer
 * id, for the rare case metadata didn't make it onto the subscription.
 */
async function resolveOrganizationId(
  admin: ReturnType<typeof createAdminClient>,
  subscription: Stripe.Subscription,
): Promise<number | null> {
  const fromMetadata = subscription.metadata?.organization_id;
  if (fromMetadata) {
    const parsed = Number(fromMetadata);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const { data } = await admin
    .from("organization_billing")
    .select("organization_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  return data?.organization_id ?? null;
}

/**
 * The invoice equivalent of resolveOrganizationId. Stripe snapshots the
 * generating subscription's metadata onto invoice.parent.subscription_
 * details.metadata at finalization time, so this needs no extra API call
 * in the common case -- falls back to the same stripe_customer_id lookup
 * resolveOrganizationId uses, for the rare case that snapshot is missing.
 */
async function resolveOrganizationIdForInvoice(
  admin: ReturnType<typeof createAdminClient>,
  invoice: Stripe.Invoice,
): Promise<number | null> {
  const fromMetadata =
    invoice.parent?.type === "subscription_details" ? invoice.parent.subscription_details?.metadata?.organization_id : undefined;
  if (fromMetadata) {
    const parsed = Number(fromMetadata);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return null;

  const { data } = await admin
    .from("organization_billing")
    .select("organization_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  return data?.organization_id ?? null;
}
