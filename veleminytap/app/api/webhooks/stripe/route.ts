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

// Statuses a subscription must be in for it to plausibly be "the current
// one" for an organization -- mirrors features/billing/status.ts's
// LIVE_SUBSCRIPTION_STATUSES exactly (kept as a separate copy, not an
// import, since this file runs against Stripe.Subscription.Status, not
// this app's own BillingStatus column type -- see pickCurrentSubscription).
const LIVE_STRIPE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "unpaid",
  "paused",
]);

/**
 * Second independent review, Finding 3: canonical retrieval
 * (stripe.subscriptions.retrieve()) is authoritative only for the ONE
 * subscription it fetches -- never for the organization or Stripe Customer
 * as a whole. A canceled sub_old, superseded by a genuinely newer sub_new,
 * still produces a real, signed webhook event whenever Stripe retries or
 * an operator manually redelivers it; retrieving and writing exactly that
 * one stale subscription would silently overwrite sub_new's live state.
 *
 * Fixed by never trusting a single retrieved subscription as this
 * organization's truth: every sync lists the event's Stripe Customer's
 * FULL subscription set and picks whichever one should currently govern
 * entitlement -- preferring a live (non-terminal) subscription over a
 * canceled/never-activated one, and among ties, the most recently created.
 * An event naming an old subscription still causes a fresh, complete
 * re-derivation of the organization's real current state, never a blind
 * overwrite with what that one event happened to carry.
 */
function pickCurrentSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
  if (subscriptions.length === 0) return null;
  const live = subscriptions.filter((s) => LIVE_STRIPE_STATUSES.has(s.status));
  const pool = live.length > 0 ? live : subscriptions;
  return pool.reduce((newest, s) => (s.created > newest.created ? s : newest));
}

/**
 * Second independent review, Finding 6: a test-mode event reaching a
 * production deployment (or a live-mode event reaching a non-production
 * one -- a misconfigured webhook endpoint pointed at the wrong Stripe
 * mode) must never be applied, fail-closed. `APP_ENV` unset (local
 * development) never receives real Stripe webhook deliveries, so there is
 * nothing to validate there -- matches /api/health's own treatment of
 * "unset" as the expected local-dev case.
 */
function checkEventEnvironment(event: Stripe.Event): { ok: true } | { ok: false; error: string } {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "production" && appEnv !== "preview") {
    return { ok: true };
  }
  const expectedLivemode = appEnv === "production";
  if (event.livemode !== expectedLivemode) {
    return {
      ok: false,
      error:
        `Refusing to process Stripe event ${event.id}: event.livemode is ${event.livemode} but APP_ENV is ` +
        `"${appEnv}" (expected livemode ${expectedLivemode}). A test-mode event reaching this environment, or a ` +
        "live-mode event reaching a non-production one, must never be applied.",
    };
  }
  return { ok: true };
}

/**
 * Stripe webhook endpoint. Public by necessity (Stripe's servers call this
 * with no session at all) -- the signature check below is the actual
 * security boundary, not proxy.ts's auth gate. See proxy.ts's PUBLIC_PATHS.
 *
 * Invariants that matter more here than almost anywhere else in this
 * codebase (per the product skill's Stripe section):
 *   1. Verify the signature before trusting anything in the body -- an
 *      unverified POST to this URL could otherwise grant a free
 *      subscription to any organization_id an attacker guesses.
 *   2. Reject a livemode/environment mismatch before applying anything
 *      (Finding 6) -- see checkEventEnvironment.
 *   3. Idempotent, crash-safe processing -- Stripe explicitly documents
 *      at-least-once, possibly-duplicate delivery (retries on anything but
 *      a 2xx response, and occasional redelivery even without one). The
 *      state-changing update runs FIRST and its own success is checked;
 *      the event is only recorded as processed in stripe_webhook_events
 *      AFTER that succeeds -- both syncSubscription's update and
 *      activateOnPayment's are idempotent (they always write Stripe's own
 *      current state, or a one-way "activated" flag, never increment or
 *      append), so re-running either on a genuine retry is always safe. A
 *      failure at any point returns a non-2xx status and leaves the event
 *      unrecorded, so Stripe retries it for real instead of being told it
 *      succeeded.
 *   4. Order-independent AND race-safe by construction. Two problems, two
 *      separate fixes:
 *        - Stripe does not guarantee webhook delivery order, and its own
 *          `created` timestamps only have one-second resolution -- an
 *          earlier version of this handler compared `created` timestamps
 *          to reject "stale" events and lost data on exactly that tie.
 *          Fixed by never trusting an event's own embedded snapshot at
 *          all: every event just triggers "go check what's actually true
 *          right now" for the organization (see pickCurrentSubscription),
 *          since that's what gets written regardless of which event fired
 *          it or in what order.
 *        - That "go check what's true now" itself still has a genuine
 *          write-write race under real concurrency: two deliveries for the
 *          same organization can each retrieve/list Stripe state, then
 *          race to write, with the OLDER request's write landing AFTER the
 *          newer one's and silently reverting it. billing_sync_seq (a
 *          per-organization fencing token, claimed via claim_billing_sync
 *          BEFORE any Stripe network call) closes this: each sync's final
 *          write is conditioned on still holding the exact token it
 *          claimed, so a request that finishes later than a newer one
 *          simply loses its own write instead of overwriting the newer
 *          result. See DECISIONS.md for the fuller reasoning.
 *   5. `activated_at` (Finding 5) is set ONLY from a signed `invoice.paid`
 *      event -- a durable, verified "this organization's billing has
 *      genuinely, actually been paid for" fact -- never inferred from a
 *      subscription's current status snapshot. A subscription observed as
 *      `active` proves nothing about payment history on its own: it can
 *      transition to `active` and be canceled again before any
 *      subscription-status webhook happens to be processed while it was
 *      still active, in which case a status-based signal would never fire
 *      at all and a grandfathered organization would keep its
 *      grandfathering forever despite having genuinely, successfully paid
 *      once. See activateOnPayment and features/billing/status.ts.
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
      // Only the id is trusted from the event body itself -- everything
      // else this handler writes comes from a fresh retrieve()/list()
      // below, not this embedded object, which may already be stale by
      // the time this request is processed.
      const subscriptionId = (event.data.object as Stripe.Subscription).id;
      handled = await syncSubscription(stripe, admin, subscriptionId);
      break;
    }
    case "invoice.paid": {
      handled = await activateOnPayment(admin, event.data.object as Stripe.Invoice);
      break;
    }
    default:
      // Every other event type is either irrelevant to billing state or
      // already fully covered by the events above -- explicitly ignored,
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
  // point and reprocesses -- harmless, since both handlers above are
  // idempotent -- and is reported as a duplicate once it hits this insert's
  // unique-violation.
  const { error: insertError } = await admin.from("stripe_webhook_events").insert({ id: event.id });
  if (insertError && insertError.code !== "23505") {
    return NextResponse.json({ error: "failed to record event" }, { status: 500 });
  }

  return NextResponse.json({ received: true, duplicate: insertError?.code === "23505" });
}

/**
 * Re-derives and applies an organization's CURRENT subscription state --
 * never just the one subscription named by the triggering event. Returns
 * false if the event should be retried (a Stripe call failed, the
 * organization couldn't be resolved, a customer-id mismatch was detected,
 * the fencing claim failed, or the final write errored); true once either
 * the fetched state has been durably written, or a newer reconciliation is
 * confirmed to have already superseded this one.
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
  // Finding 3: a subscription's Stripe Customer must match this
  // organization's OWN already-persisted customer. resolveOrganizationId's
  // metadata path trusts subscription.metadata.organization_id -- which
  // this app always sets itself at Checkout creation time -- but a
  // mismatch here is exactly the shape a data-integrity bug (or a forged/
  // corrupted metadata value) would produce. Never treated as permission
  // to rebind the organization to a different customer: logged loudly and
  // left for Stripe to retry (which will keep failing, visibly, until a
  // human investigates) rather than silently applied or silently dropped.
  if (orgRow.stripe_customer_id && orgRow.stripe_customer_id !== customerId) {
    console.error(
      `Refusing to sync organization ${organizationId}: its persisted Stripe customer (${orgRow.stripe_customer_id}) ` +
        `does not match subscription ${eventSubscription.id}'s customer (${customerId}) -- quarantined, not applied.`,
    );
    return false;
  }

  // Finding 4: claim this organization's reconciliation fencing token
  // BEFORE the next Stripe network call -- no database transaction ever
  // spans a Stripe call. The final write below is conditioned on still
  // holding this exact value.
  const { data: seq, error: seqError } = await admin.rpc("claim_billing_sync", {
    p_organization_id: organizationId,
  });
  if (seqError || seq == null) {
    console.error(
      `Failed to claim a billing-sync fencing token for organization ${organizationId}: ${seqError?.message ?? "no value returned"}`,
    );
    return false;
  }

  // Finding 3: list this Stripe Customer's FULL subscription set and pick
  // whichever should currently govern entitlement -- never trust the one
  // subscription this event happens to name.
  let subscriptions: Stripe.Subscription[];
  try {
    const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    subscriptions = list.data;
  } catch (err) {
    console.error(
      `Failed to list Stripe subscriptions for customer ${customerId} (organization ${organizationId}): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  const current = pickCurrentSubscription(subscriptions);
  if (!current) {
    console.error(
      `Stripe reports no subscriptions at all for customer ${customerId} (organization ${organizationId}) -- unexpected for an event that names one`,
    );
    return false;
  }

  const item = current.items.data[0];
  const payload: OrganizationBillingUpdate = {
    stripe_customer_id: customerId,
    stripe_subscription_id: current.id,
    status: toBillingStatus(current.status),
    current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: current.cancel_at_period_end,
    // Diagnostic only (DECISIONS.md) -- when this organization's billing
    // state was last synced. Never read back or compared against.
    last_synced_at: new Date().toISOString(),
    // A real subscription now genuinely exists for this organization --
    // any pending Checkout attempt (features/billing/actions.ts) has been
    // fulfilled, successfully or not, and must not keep blocking a future
    // legitimate attempt. Always cleared here rather than left to its own
    // expiry, so a completed checkout is reflected immediately.
    pending_checkout_session_id: null,
    checkout_attempt_id: null,
    checkout_attempt_interval: null,
    checkout_attempt_price_id: null,
    checkout_attempt_mode: null,
    checkout_attempt_expires_at: null,
  };

  const { data: updated, error: updateError } = await admin
    .from("organization_billing")
    .update(payload)
    .eq("organization_id", organizationId)
    .eq("billing_sync_seq", seq)
    .select("organization_id")
    .maybeSingle();

  if (updateError) {
    console.error(`Failed to sync billing state for organization ${organizationId}: ${updateError.message}`);
    return false;
  }
  if (!updated) {
    // Fenced out -- a newer reconciliation for this organization has
    // already advanced billing_sync_seq past the value this call claimed.
    // Not a failure: that newer sync already covers whatever this event
    // would have written (both re-derive the SAME "current Stripe truth"
    // independently), so there is nothing left for this call to do.
    console.log(
      `organization ${organizationId}: superseded by a newer reconciliation (billing_sync_seq advanced past ${seq}) -- this event's effect is already covered by that newer sync.`,
    );
  }

  return true;
}

/**
 * Finding 5: sets the one-way "this organization's billing has genuinely,
 * actually been paid for" fact from a signed `invoice.paid` event -- the
 * only durable, verified payment-success signal this handler trusts for
 * activation. Deliberately decoupled from syncSubscription/subscription
 * status entirely: current subscription state and historical payment
 * activation are separate concepts (see features/billing/status.ts).
 * Idempotent by construction (`.is("activated_at", null)`) -- a duplicate
 * delivery, a second successful invoice, or events arriving in any order
 * all converge on the same result, and a subscription canceled moments
 * after this invoice paid does not un-set it.
 */
async function activateOnPayment(
  admin: ReturnType<typeof createAdminClient>,
  invoice: Stripe.Invoice,
): Promise<boolean> {
  // Only a subscription invoice ever represents this app's billing having
  // started -- there is no other invoice type this product issues.
  if (invoice.parent?.type !== "subscription_details") {
    return true;
  }
  if (invoice.status !== "paid") {
    // `invoice.paid` events should always carry status === "paid" -- this
    // is a cheap, meaningful guard against ever activating on a
    // same-shaped event that isn't actually a successful payment.
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

  const { error } = await admin
    .from("organization_billing")
    .update({ activated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .is("activated_at", null)
    .select("organization_id")
    .maybeSingle();

  if (error) {
    console.error(`Failed to record billing activation for organization ${organizationId}: ${error.message}`);
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
 * resolveOrganizationId uses, for the rare case that snapshot is missing
 * (Stripe documents it as populated only for invoices created on or after
 * 2023-06-29, which predates this integration, but a defensive fallback
 * costs nothing).
 */
async function resolveOrganizationIdForInvoice(
  admin: ReturnType<typeof createAdminClient>,
  invoice: Stripe.Invoice,
): Promise<number | null> {
  const fromMetadata = invoice.parent?.subscription_details?.metadata?.organization_id;
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
