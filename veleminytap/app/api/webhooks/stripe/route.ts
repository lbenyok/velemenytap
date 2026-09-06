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
 * Three invariants that matter more here than almost anywhere else in this
 * codebase (per the product skill's Stripe section):
 *   1. Verify the signature before trusting anything in the body -- an
 *      unverified POST to this URL could otherwise grant a free
 *      subscription to any organization_id an attacker guesses.
 *   2. Idempotent, crash-safe processing -- Stripe explicitly documents
 *      at-least-once, possibly-duplicate delivery (retries on anything but
 *      a 2xx response, and occasional redelivery even without one).
 *      Found during an independent review: this used to record the event
 *      id as processed FIRST, then update organization_billing as a
 *      separate, later, unchecked call -- two independent Supabase
 *      requests, not one transaction. If the process crashed, timed out,
 *      or the update simply failed for any reason between those two
 *      calls, the event was permanently marked done while its actual
 *      effect was never applied -- and Stripe would never retry it, either
 *      because a 200 had already gone out, or because a retried delivery
 *      hit the already-recorded event id and short-circuited before
 *      reaching the update at all. A real paid subscription could vanish
 *      silently, looking identical to success. Fixed by reordering: the
 *      state-changing update now happens FIRST and its own success is
 *      checked, and the event is only recorded as processed AFTER that
 *      succeeds -- syncSubscription's update is naturally idempotent (it
 *      always sets fields to the exact snapshot the current event
 *      describes, never increments or appends), so re-running it on a
 *      genuine retry is always safe. A failure at any point now returns a
 *      non-2xx status and leaves the event unrecorded, so Stripe retries
 *      it for real instead of being told it succeeded.
 *   3. Out-of-order-safe -- Stripe does not guarantee delivery order.
 *      syncSubscription only applies an event if its own `created`
 *      timestamp is newer than the last one already applied for that
 *      organization, enforced inside the UPDATE's own WHERE clause so the
 *      check and the write happen atomically even under concurrent
 *      deliveries for the same organization, not just sequential-but-
 *      reordered ones.
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

  let handled = true;
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      handled = await syncSubscription(admin, subscription, new Date(event.created * 1000));
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

  if (!handled) {
    // The event's own effect was not (fully) applied -- never record it
    // as processed, and ask Stripe to retry.
    return NextResponse.json({ error: "failed to apply event" }, { status: 500 });
  }

  // Recorded only now, after the event's effect has actually been applied
  // (or correctly determined not to need applying -- see syncSubscription).
  // A duplicate delivery of an already-recorded event still reaches this
  // point and reprocesses -- harmless, since the update above is
  // idempotent -- and is reported as a duplicate once it hits this insert's
  // unique-violation.
  const { error: insertError } = await admin.from("stripe_webhook_events").insert({ id: event.id });
  if (insertError && insertError.code !== "23505") {
    return NextResponse.json({ error: "failed to record event" }, { status: 500 });
  }

  return NextResponse.json({ received: true, duplicate: insertError?.code === "23505" });
}

/**
 * Applies one subscription event's effect to organization_billing.
 * Returns false if the event's effect was NOT applied and Stripe should
 * retry; true if it was applied, or if it was correctly determined not to
 * need applying (a stale/out-of-order event, or a genuine duplicate of one
 * already applied).
 */
async function syncSubscription(
  admin: ReturnType<typeof createAdminClient>,
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
): Promise<boolean> {
  const organizationId = await resolveOrganizationId(admin, subscription);
  if (organizationId === null) {
    console.error(
      `Could not resolve an organization for Stripe subscription ${subscription.id} -- no metadata.organization_id and no matching stripe_customer_id`,
    );
    return false;
  }

  const item = subscription.items.data[0];
  const eventCreatedIso = eventCreatedAt.toISOString();

  const { data: updated, error: updateError } = await admin
    .from("organization_billing")
    .update({
      stripe_customer_id:
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      stripe_subscription_id: subscription.id,
      status: toBillingStatus(subscription.status),
      current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      last_synced_event_created_at: eventCreatedIso,
    })
    .eq("organization_id", organizationId)
    // Out-of-order guard, enforced atomically in the same statement as the
    // write: only apply this event if it's newer than the last one this
    // organization actually had applied (or nothing has been applied yet).
    .or(`last_synced_event_created_at.is.null,last_synced_event_created_at.lt.${eventCreatedIso}`)
    .select("organization_id")
    .maybeSingle();

  if (updateError) {
    console.error(`Failed to sync billing state for organization ${organizationId}: ${updateError.message}`);
    return false;
  }

  if (updated) {
    return true;
  }

  // The update matched zero rows. Two very different reasons that can
  // happen, and only one of them is a failure:
  //   - organization_billing has no row at all for this organization -- a
  //     real data-integrity problem (see the grandfathering migration's
  //     comment for why every organization should always have one).
  //   - the row exists, but this event is older than (or exactly as old
  //     as) one already applied -- correctly skipped, not a failure.
  const { data: existing, error: existError } = await admin
    .from("organization_billing")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existError || !existing) {
    console.error(
      `organization_billing has no row for organization ${organizationId} -- cannot sync Stripe subscription ${subscription.id}`,
    );
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
