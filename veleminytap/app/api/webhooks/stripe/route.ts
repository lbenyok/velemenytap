import { type NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BillingStatus, Database } from "@/lib/supabase/database.types";

type OrganizationBillingUpdate = Database["public"]["Tables"]["organization_billing"]["Update"];

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
 *      a 2xx response, and occasional redelivery even without one). The
 *      state-changing update runs FIRST and its own success is checked;
 *      the event is only recorded as processed in stripe_webhook_events
 *      AFTER that succeeds -- syncSubscription's update is idempotent (it
 *      always writes Stripe's own current state, never increments or
 *      appends), so re-running it on a genuine retry is always safe. A
 *      failure at any point returns a non-2xx status and leaves the event
 *      unrecorded, so Stripe retries it for real instead of being told it
 *      succeeded -- the previous, opposite ordering (record first, update
 *      second) meant a crash between the two calls permanently marked a
 *      never-applied event as done.
 *   3. Order-independent by construction -- Stripe does not guarantee
 *      webhook delivery order, and its own `created` timestamps only have
 *      one-second resolution, so two genuinely distinct events for the
 *      same subscription can share an identical timestamp. An earlier
 *      version of this handler tried to compare `created` timestamps to
 *      reject "stale" events and lost data on exactly that tie (the
 *      second same-second event's `<` comparison against the first's
 *      already-recorded timestamp evaluated false, so it was skipped as
 *      stale even though it carried the real, newer state). Fixed by
 *      never trusting an event's own embedded snapshot at all:
 *      syncSubscription re-fetches the subscription directly from Stripe
 *      (`stripe.subscriptions.retrieve`, Stripe's own documented pattern
 *      for this exact class of problem) and writes whatever that
 *      canonical, live lookup returns. Every event just triggers a
 *      "go check what's actually true right now" -- since that's what
 *      gets written regardless of which event fired it or in what order,
 *      there is no timestamp comparison left to have a precision bug in.
 *      See DECISIONS.md for the fuller reasoning, including the narrow,
 *      self-healing residual race under genuinely concurrent deliveries
 *      for the same subscription.
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
      // Only the id is trusted from the event body itself -- everything
      // else this handler writes comes from a fresh retrieve() below, not
      // this embedded object, which may already be stale by the time this
      // request is processed.
      const subscriptionId = (event.data.object as Stripe.Subscription).id;
      handled = await syncSubscription(stripe, admin, subscriptionId);
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

  // Recorded only now, after the event's effect has actually been applied.
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
 * Applies a subscription's current, canonically-fetched Stripe state to
 * organization_billing. Returns false if the event should be retried
 * (the retrieve() call itself failed, the organization couldn't be
 * resolved, the update errored, or organization_billing has no row for
 * it); true once the fetched state has been durably written.
 */
async function syncSubscription(
  stripe: Stripe,
  admin: ReturnType<typeof createAdminClient>,
  subscriptionId: string,
): Promise<boolean> {
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(
      `Failed to retrieve canonical state for Stripe subscription ${subscriptionId}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  const organizationId = await resolveOrganizationId(admin, subscription);
  if (organizationId === null) {
    console.error(
      `Could not resolve an organization for Stripe subscription ${subscription.id} -- no metadata.organization_id and no matching stripe_customer_id`,
    );
    return false;
  }

  // Read first, rather than inferring existence from a zero-row UPDATE
  // result: this sync also needs to know whether activated_at is already
  // set, to decide whether this event marks the organization's FIRST
  // successful activation (see status.ts's isBillingActive and the
  // activated_at migration's own comment for why that's a one-time,
  // never-overwritten signal, not the current subscription's own status).
  const { data: current, error: readError } = await admin
    .from("organization_billing")
    .select("activated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (readError) {
    console.error(`Failed to read organization_billing for organization ${organizationId}: ${readError.message}`);
    return false;
  }
  if (!current) {
    // A real data-integrity problem, not a legitimate state -- every
    // organization should always have a row (see the grandfathering
    // migration's comment for why).
    console.error(
      `organization_billing has no row for organization ${organizationId} -- cannot sync Stripe subscription ${subscription.id}`,
    );
    return false;
  }

  const item = subscription.items.data[0];
  const updatePayload: OrganizationBillingUpdate = {
    stripe_customer_id:
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripe_subscription_id: subscription.id,
    status: toBillingStatus(subscription.status),
    current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    // Diagnostic only (DECISIONS.md) -- when this organization's billing
    // state was last synced, not tied to any particular event's own
    // timestamp. Never read back or compared against.
    last_synced_at: new Date().toISOString(),
    // A real subscription now genuinely exists for this organization --
    // any pending Checkout intent (features/billing/actions.ts's
    // claimAndCreateCheckoutSession) has been fulfilled, successfully or
    // not, and must not keep blocking a future legitimate attempt. Always
    // cleared here rather than left to its own expiry, so a completed
    // checkout is reflected immediately, not just after the lease's own
    // (up to 24h) timeout.
    pending_checkout_session_id: null,
    pending_checkout_expires_at: null,
  };
  // Set only on the transition INTO 'active' for an organization that has
  // never activated before -- omitted from the payload entirely (not set
  // to null) once already set, so it is never overwritten by a later
  // cancellation, a later reactivation, or a differently-timed duplicate
  // delivery of this same event.
  if (subscription.status === "active" && current.activated_at == null) {
    updatePayload.activated_at = new Date().toISOString();
  }

  const { data: updated, error: updateError } = await admin
    .from("organization_billing")
    .update(updatePayload)
    .eq("organization_id", organizationId)
    .select("organization_id")
    .maybeSingle();

  if (updateError) {
    console.error(`Failed to sync billing state for organization ${organizationId}: ${updateError.message}`);
    return false;
  }
  if (!updated) {
    // The row existed moments ago (the read above) but the update
    // matched zero rows -- there is no legitimate way for that to happen
    // (nothing deletes organization_billing rows), so this is a genuine,
    // unexpected failure worth a retry rather than a silent success.
    console.error(`organization_billing row for organization ${organizationId} vanished between read and update`);
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
