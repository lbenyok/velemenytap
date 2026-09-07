"use server";

import { redirect } from "next/navigation";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { hasLiveSubscription, canManageBilling } from "@/features/billing/status";
import { isBillingInterval, stripePriceId, type BillingInterval } from "@/features/billing/plans";

// Collapses a double form-submit landing within the SAME short window into
// the same Stripe request -- defense in depth alongside the database-backed
// checkout lease below (claimAndCreateCheckoutSession), not the primary
// protection anymore (see that function's own comment for why the lease is
// what actually prevents a duplicate Checkout Session, not this key alone).
// Scoped to a short window, not the organization permanently, since Stripe
// only remembers an idempotency key for 24 hours and a genuine later
// resubscribe attempt must not be blocked by an earlier, unrelated one.
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 30_000;

// How long a "claiming, about to call Stripe" lease is held before another
// attempt may retry -- bounds how long a crashed or hung request can block
// a legitimate retry, without being so short that a normal Stripe API
// round trip could race past it.
const CHECKOUT_CLAIM_WINDOW_MS = 60_000;

// How long a real, already-created Checkout Session's own lease lasts --
// matches Stripe's own default Checkout Session expiration (24 hours), so
// this app's own record of "is there still an open session to reuse"
// never outlives the session itself being reusable on Stripe's side.
const CHECKOUT_SESSION_LEASE_MS = 24 * 60 * 60 * 1000;

/**
 * Finds this organization's Stripe customer, creating one on first use.
 * Uses the admin client -- organization_billing has no UPDATE policy for
 * `authenticated` (see the billing migration), by design: an owner must
 * never be able to grant their own organization an active subscription
 * by writing to this table directly.
 *
 * Found during an independent review: every organization is supposed to
 * have exactly one organization_billing row (created by the provisioning
 * trigger, or -- for an organization that predates billing entirely -- by
 * the grandfathering migration's backfill), but this function used to
 * treat a missing row silently: a failed `.single()` left `billing` as
 * `undefined`, `billing?.stripe_customer_id` was falsy either way, and
 * execution fell straight through to creating a brand-new Stripe customer
 * whose id then went into an UPDATE that matched zero rows -- also
 * unchecked. The net effect was a real Stripe customer (and, had checkout
 * completed, a real paid subscription) that this database could never
 * again look up, for any organization whose row was ever missing. A
 * missing row is now a hard failure here, not a silent "must be a new
 * customer" inference -- see the migration comment for why it should
 * never legitimately happen once the grandfathering backfill has run.
 *
 * A second independent review found the concurrency guard below still had
 * a real gap: `stripe.customers.create()` itself carried no Stripe-level
 * idempotency key, so the LOSING side of a race (two concurrent calls for
 * an organization with no customer yet) had already created a real,
 * orphaned Stripe Customer object by the time it discovered the other
 * side had won and persisted first -- wasted, but more importantly, a
 * genuine connection failure between that create() call succeeding and
 * this function's own UPDATE running would leave `stripe_customer_id`
 * still null with a real customer already sitting in Stripe, unreachable
 * on the next retry (which would just create ANOTHER one). A stable,
 * organization-scoped idempotency key -- never time-bucketed, unlike
 * Checkout's own key below, since an organization should only ever have
 * ONE customer for its whole lifetime, not one per attempt -- fixes both:
 * Stripe itself deduplicates any repeated create() call for the same
 * organization (concurrent or a later retry after a connection failure)
 * within its own idempotency-key retention window, returning the SAME
 * customer object instead of creating a second one.
 */
async function getOrCreateStripeCustomerId(
  organizationId: number,
  organizationName: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data: billing, error: readError } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to read organization_billing for organization ${organizationId}: ${readError.message}`);
  }
  if (!billing) {
    throw new Error(
      `organization_billing has no row for organization ${organizationId} -- every organization should have one ` +
        "(provisioning trigger, or the grandfathering backfill for a pre-existing organization).",
    );
  }

  if (billing.stripe_customer_id) {
    return billing.stripe_customer_id;
  }

  const stripe = createStripeClient();
  const customer = await stripe.customers.create(
    {
      name: organizationName,
      metadata: { organization_id: organizationId.toString() },
    },
    { idempotencyKey: `customer-create:org-${organizationId}` },
  );

  // Concurrency guard: `.is("stripe_customer_id", null)` means this
  // UPDATE only actually applies if nothing else has already set it since
  // the read above -- a second, concurrent call (e.g. a double-submitted
  // form) racing this same function for the same organization will lose
  // this UPDATE (it matches zero rows) rather than overwriting the
  // winner's id with its own. With the idempotency key above, both sides
  // of that race hold the SAME customer.id anyway (Stripe returns the
  // identical object to both), so this is now a tie-break on which write
  // wins, not a risk of two different customers ending up referenced.
  const { data: updated, error: updateError } = await admin
    .from("organization_billing")
    .update({ stripe_customer_id: customer.id })
    .eq("organization_id", organizationId)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to persist Stripe customer id for organization ${organizationId}: ${updateError.message}`);
  }
  if (updated) {
    return customer.id;
  }

  // Lost the race -- someone else's concurrent call already set
  // stripe_customer_id first. Use the winner's id instead of the one just
  // created here, so this function always returns the one id this
  // organization's row actually has.
  const { data: raced, error: racedError } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (racedError || !raced?.stripe_customer_id) {
    throw new Error(
      `Failed to resolve Stripe customer id for organization ${organizationId} after a concurrent update`,
    );
  }
  return raced.stripe_customer_id;
}

/**
 * Claims a database-backed lease for this organization before ever calling
 * Stripe, so two concurrent createCheckoutSessionAction calls (a
 * double-click, a second tab, a retried request after a slow response)
 * can't both create a separate Checkout Session. Found during an
 * independent review: the previous design relied entirely on a 30-second,
 * time-bucketed Stripe idempotency key -- real protection against a rapid
 * double-submit landing in the same bucket, none at all against two
 * submissions a minute apart, or two different intervals (monthly vs.
 * yearly) submitted close together, neither of which shares a key.
 *
 * Two-phase, both enforced atomically in the UPDATE's own WHERE clause
 * (not a read-then-write race):
 *   1. Claim a short "about to call Stripe" window
 *      (pending_checkout_expires_at a minute out,
 *      pending_checkout_session_id still null). Only succeeds if nothing
 *      else currently holds a valid lease.
 *   2. Once Stripe actually responds, record the real session id and
 *      extend the lease to match the session's own real lifetime -- a
 *      third concurrent call within that window reuses the existing open
 *      session (fetched fresh from Stripe, never trusted from this row's
 *      own cached state) instead of creating a new one at all.
 *
 * The lease is cleared by the webhook once a subscription genuinely
 * exists for this organization (app/api/webhooks/stripe/route.ts) -- see
 * that migration's own comment for why no separate Stripe event handler
 * is needed for the "abandoned, never completed" case (the lease's own
 * expiry covers it).
 */
async function claimAndCreateCheckoutSession(
  organizationId: number,
  organizationName: string,
  interval: BillingInterval,
  siteUrl: string,
): Promise<string> {
  const admin = createAdminClient();
  const stripe = createStripeClient();

  const { data: current, error: readError } = await admin
    .from("organization_billing")
    .select("pending_checkout_session_id, pending_checkout_expires_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readError) {
    throw new Error(`Failed to read organization_billing for organization ${organizationId}: ${readError.message}`);
  }
  if (!current) {
    throw new Error(`organization_billing has no row for organization ${organizationId}`);
  }

  const leaseIsValid =
    current.pending_checkout_expires_at !== null && new Date(current.pending_checkout_expires_at) > new Date();

  if (leaseIsValid && current.pending_checkout_session_id) {
    // A session may already be open -- Stripe's own status is the
    // authoritative check, never this row's own cached state, which could
    // be stale relative to what actually happened on Stripe's side.
    const existing = await stripe.checkout.sessions.retrieve(current.pending_checkout_session_id);
    if (existing.status === "open" && existing.url) {
      return existing.url;
    }
    if (existing.status === "complete") {
      // This organization's checkout already succeeded -- creating
      // another would risk a second subscription. Send it to the same
      // place success_url would have.
      return `${siteUrl}/dashboard/billing?checkout=success`;
    }
    // 'expired' on Stripe's side -- release the stale lease before
    // claiming a fresh one below (otherwise the claim's own WHERE clause,
    // which only looks at OUR expiry, would still see it as valid).
    await admin
      .from("organization_billing")
      .update({ pending_checkout_session_id: null, pending_checkout_expires_at: null })
      .eq("organization_id", organizationId);
  } else if (leaseIsValid) {
    // pending_checkout_session_id is still null: a concurrent call is
    // actively claiming right now (mid Stripe API round trip). Don't race
    // ahead of it.
    throw new Error("A checkout attempt for this organization is already in progress -- try again in a moment.");
  }

  const nowIso = new Date().toISOString();
  const claimExpiry = new Date(Date.now() + CHECKOUT_CLAIM_WINDOW_MS).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("organization_billing")
    .update({ pending_checkout_session_id: null, pending_checkout_expires_at: claimExpiry })
    .eq("organization_id", organizationId)
    .or(`pending_checkout_expires_at.is.null,pending_checkout_expires_at.lt.${nowIso}`)
    .select("organization_id")
    .maybeSingle();
  if (claimError) {
    throw new Error(`Failed to claim a checkout lease for organization ${organizationId}: ${claimError.message}`);
  }
  if (!claimed) {
    // Lost a genuine race against a concurrent call between the read
    // above and this UPDATE's own atomic check.
    throw new Error("A checkout attempt for this organization is already in progress -- try again in a moment.");
  }

  const customerId = await getOrCreateStripeCustomerId(organizationId, organizationName);
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: organizationId.toString(),
      line_items: [{ price: stripePriceId(interval), quantity: 1 }],
      success_url: `${siteUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
      metadata: { organization_id: organizationId.toString() },
      // Carried forward onto the Subscription object itself, not just
      // this Checkout Session -- the webhook handler reads it from every
      // subsequent subscription event (including ones from the customer
      // portal, which never goes through this action again).
      subscription_data: { metadata: { organization_id: organizationId.toString() } },
    },
    {
      idempotencyKey: `checkout:org-${organizationId}:${interval}:${Math.floor(Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS)}`,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }

  await admin
    .from("organization_billing")
    .update({
      pending_checkout_session_id: session.id,
      pending_checkout_expires_at: new Date(Date.now() + CHECKOUT_SESSION_LEASE_MS).toISOString(),
    })
    .eq("organization_id", organizationId);

  return session.url;
}

/**
 * Starts a Stripe Checkout session for this organization's subscription
 * and redirects to it. Stripe Checkout is a Stripe-hosted page -- no card
 * data ever touches this app's own server or client code.
 *
 * next/navigation's redirect() works by throwing -- it must never be
 * called inside a try whose catch is meant for Stripe/DB failures, or the
 * catch swallows it and reports the wrong error. Every redirect target is
 * decided first (a plain string), and the actual redirect() call happens
 * once, after the try/catch.
 *
 * `interval` comes from which of the billing page's two forms was
 * submitted (`features/billing/plans.ts`'s "monthly"/"yearly") -- validated
 * against that same allowlist here too, not trusted from the client, since
 * a crafted form submission could otherwise send any string through to
 * `stripePriceId()`.
 *
 * Found during an independent review: this used only organization
 * existence to authorize the call, ignoring the membership role
 * `getCurrentOrganization()` already returns -- any signed-in member,
 * including `manager`/`staff`, could start (and, via the Billing Portal,
 * cancel) a real subscription. Restricted to `canManageBilling`'s roles.
 */
export async function createCheckoutSessionAction(formData: FormData): Promise<void> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  if (!canManageBilling(organization.role)) {
    redirect("/dashboard/billing?error=unauthorized");
  }

  const interval = formData.get("interval");
  if (!isBillingInterval(interval)) {
    redirect("/dashboard/billing?error=checkout_failed");
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!;
  let target: string;

  try {
    const billing = await getOrganizationBilling(organization.id);
    if (hasLiveSubscription(billing)) {
      // The billing page itself only ever renders the Checkout forms when
      // there's no live subscription yet (see app/dashboard/billing/
      // page.tsx) -- this is the server-side half of that same rule, for
      // a request that reaches this action anyway (stale page state, a
      // replayed submission, or a direct POST) not otherwise reflected in
      // a client render. A canceled or never-completed (incomplete_expired)
      // subscription is deliberately NOT "live" -- see hasLiveSubscription
      // -- so a resubscribe attempt is allowed past this check.
      target = "/dashboard/billing?error=already_subscribed";
    } else {
      target = await claimAndCreateCheckoutSession(organization.id, organization.name, interval, siteUrl);
    }
  } catch {
    target = "/dashboard/billing?error=checkout_failed";
  }

  redirect(target);
}

/**
 * Opens the Stripe-hosted Billing Portal, where an org can update its
 * card, view invoices, or cancel -- all without this app ever handling
 * payment details itself. See createCheckoutSessionAction's comment on
 * why redirect() is only ever called once, outside the try/catch, and on
 * why this also enforces canManageBilling.
 */
export async function createPortalSessionAction(): Promise<void> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  if (!canManageBilling(organization.role)) {
    redirect("/dashboard/billing?error=unauthorized");
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!;
  let target: string;

  try {
    const admin = createAdminClient();
    const { data: billing, error: readError } = await admin
      .from("organization_billing")
      .select("stripe_customer_id")
      .eq("organization_id", organization.id)
      .maybeSingle();

    if (readError) {
      throw new Error(`Failed to read organization_billing for organization ${organization.id}: ${readError.message}`);
    }

    if (!billing?.stripe_customer_id) {
      target = "/dashboard/billing?error=no_subscription";
    } else {
      const stripe = createStripeClient();
      const session = await stripe.billingPortal.sessions.create({
        customer: billing.stripe_customer_id,
        return_url: `${siteUrl}/dashboard/billing`,
      });
      target = session.url;
    }
  } catch {
    target = "/dashboard/billing?error=portal_failed";
  }

  redirect(target);
}
