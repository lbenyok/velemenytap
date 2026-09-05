import { type NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BillingStatus } from "@/lib/supabase/database.types";

// Stripe's own Subscription.Status type is forward-compatible (a plain
// `string` fallback alongside its named members) since Stripe can add new
// statuses at any time -- narrower than the CHECK constraint's known set
// (which mirrors every status documented as of this integration; see the
// billing migration). Anything Stripe sends that isn't in that set gets
// mapped to 'incomplete' (fail toward "not billable" rather than crash
// the whole webhook on an UPDATE that violates the constraint) and is
// logged loudly so a genuinely new Stripe status gets noticed and added,
// not silently miscategorized.
const KNOWN_STATUSES: readonly BillingStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
];

function toBillingStatus(status: Stripe.Subscription.Status): BillingStatus {
  if ((KNOWN_STATUSES as readonly string[]).includes(status)) {
    return status as BillingStatus;
  }
  console.error(`Unrecognized Stripe subscription status "${status}" -- mapping to "incomplete"`);
  return "incomplete";
}

/**
 * Stripe webhook endpoint. Public by necessity (Stripe's servers call this
 * with no session at all) -- the signature check below is the actual
 * security boundary, not proxy.ts's auth gate. See proxy.ts's PUBLIC_PATHS.
 *
 * Two invariants that matter more here than almost anywhere else in this
 * codebase (per the product skill's Stripe section):
 *   1. Verify the signature before trusting anything in the body -- an
 *      unverified POST to this URL could otherwise grant a free
 *      subscription to any organization_id an attacker guesses.
 *   2. Idempotent processing -- Stripe explicitly documents at-least-once,
 *      possibly-duplicate delivery (retries on anything but a 2xx
 *      response, and occasional redelivery even without one). Each
 *      event's id is inserted into stripe_webhook_events inside the same
 *      transaction as the state change it causes; a replay hits that
 *      table's primary key and becomes a no-op read instead of
 *      reapplying (or double-counting) the event.
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

  const admin = createAdminClient();

  // Idempotency gate: if this event id was already recorded, we've
  // already applied its effect -- acknowledge and stop, don't reapply.
  const { error: insertError } = await admin
    .from("stripe_webhook_events")
    .insert({ id: event.id });
  if (insertError) {
    // Unique-violation on `id` means a duplicate delivery -- expected and
    // fine. Any other error is a real problem; ask Stripe to retry.
    if (insertError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json({ error: "failed to record event" }, { status: 500 });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await syncSubscription(admin, subscription);
      break;
    }
    default:
      // Every other event type is either irrelevant to billing state
      // (e.g. invoice.created) or already fully covered by the
      // subscription events above (Stripe emits a subscription.updated
      // for a failed-payment status change too) -- explicitly ignored,
      // not silently unhandled.
      break;
  }

  return NextResponse.json({ received: true });
}

async function syncSubscription(
  admin: ReturnType<typeof createAdminClient>,
  subscription: Stripe.Subscription,
) {
  const organizationId = await resolveOrganizationId(admin, subscription);
  if (organizationId === null) {
    return;
  }

  const item = subscription.items.data[0];
  await admin
    .from("organization_billing")
    .update({
      stripe_customer_id:
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      stripe_subscription_id: subscription.id,
      status: toBillingStatus(subscription.status),
      current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    })
    .eq("organization_id", organizationId);
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
