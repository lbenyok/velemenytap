"use server";

import { redirect } from "next/navigation";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { hasLiveSubscription, canManageBilling } from "@/features/billing/status";
import { isBillingInterval, stripePriceId, type BillingInterval } from "@/features/billing/plans";
import { assertStripeConfigurationValid } from "@/features/billing/stripe-config";

// How long a genuinely new checkout attempt's CLAIM lasts before another
// attempt may reclaim the slot -- bounds how long a crashed or hung
// request can block a legitimate retry. Must comfortably exceed the
// installed Stripe SDK's own default request timeout (80s) plus margin,
// or a request that's still genuinely in flight could be reclaimed out
// from under itself.
const CHECKOUT_CLAIM_SECONDS = 150;

// How long a real, already-created Checkout Session's own lease lasts --
// matches Stripe's own default Checkout Session expiration (24 hours), so
// this app's own record of "is there still a session to reconcile/reuse"
// never outlives the session itself being reachable on Stripe's side.
const CHECKOUT_SESSION_LEASE_SECONDS = 24 * 60 * 60;

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
 * treat a missing row silently. A missing row is a hard failure here.
 *
 * A second independent review found the concurrency guard below still had
 * a real gap: `stripe.customers.create()` itself carried no Stripe-level
 * idempotency key, so the LOSING side of a race (two concurrent calls for
 * an organization with no customer yet) had already created a real,
 * orphaned Stripe Customer object by the time it discovered the other
 * side had won and persisted first -- and a genuine connection failure
 * between that create() call succeeding and this function's own UPDATE
 * running would leave `stripe_customer_id` still null with a real
 * customer already sitting in Stripe, unreachable on the next retry
 * (which would just create ANOTHER one). A stable, organization-scoped
 * idempotency key -- never time-bucketed, since an organization should
 * only ever have ONE customer for its whole lifetime, not one per attempt
 * -- fixes both: Stripe itself deduplicates any repeated create() call for
 * the same organization (concurrent, or a later retry after a connection
 * failure) within its own idempotency-key retention window, returning the
 * SAME customer object instead of creating a second one.
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
 * Claims a durable, database-backed Checkout attempt for this organization
 * before ever calling Stripe, reconciles any session left by a prior
 * attempt against Stripe's own live state, and creates a fresh Checkout
 * Session only once nothing reusable exists.
 *
 * Second independent review, Finding 2: the previous lease design had
 * several real gaps, all closed here:
 *   - it expired after 60s while the installed Stripe SDK can wait 80s --
 *     CHECKOUT_CLAIM_SECONDS (150s) comfortably exceeds that.
 *   - its final Supabase write ignored `{ error }` and affected-row count
 *     -- every RPC call below is checked and fails closed on an error or
 *     an unexpected null/false result.
 *   - claim/release/finalize had no owner/attempt token or compare-and-
 *     swap condition -- claim_checkout_attempt/record_checkout_session/
 *     release_checkout_attempt (supabase/migrations/20260907200000) all
 *     condition their writes on an opaque, immutable attempt id, so a
 *     delayed caller holding a superseded attempt id can never modify a
 *     newer claim.
 *   - lease decisions used the application server's own clock -- every
 *     comparison now happens inside the database functions themselves,
 *     using clock_timestamp().
 *   - a retry used a different time-bucketed Stripe idempotency key -- the
 *     key below is derived from the durable attempt id, stable across any
 *     retry that still holds the same (unexpired) attempt.
 *   - a stored COMPLETED session was never reconciled once the local lease
 *     expired -- claim_checkout_attempt returns a superseded attempt's own
 *     session id specifically so it can still be checked here, even after
 *     its own lease has lapsed.
 *   - an open monthly session could be reused for a yearly request --
 *     interval AND Price ID are stored per attempt and compared before any
 *     reuse; a mismatch releases the stale attempt and claims a genuinely
 *     fresh one instead of reusing across plans.
 */
async function claimAndCreateCheckoutSession(
  organizationId: number,
  organizationName: string,
  interval: BillingInterval,
  siteUrl: string,
): Promise<string> {
  const admin = createAdminClient();
  const stripe = createStripeClient();
  const priceId = stripePriceId(interval);

  const { data: claimRows, error: claimError } = await admin.rpc("claim_checkout_attempt", {
    p_organization_id: organizationId,
    p_interval: interval,
    p_price_id: priceId,
    p_mode: "subscription",
    p_claim_seconds: CHECKOUT_CLAIM_SECONDS,
  });
  if (claimError) {
    throw new Error(`Failed to claim a checkout attempt for organization ${organizationId}: ${claimError.message}`);
  }
  const claim = claimRows?.[0];
  if (!claim) {
    throw new Error(`claim_checkout_attempt returned no row for organization ${organizationId}`);
  }
  let attemptId = claim.attempt_id;

  if (claim.existing_session_id) {
    // Reconcile against Stripe's own live state -- never this row's own
    // cached status, which could be stale relative to what actually
    // happened on Stripe's side, and never skipped just because the local
    // claim lease around this session happened to already expire.
    const existing = await stripe.checkout.sessions.retrieve(claim.existing_session_id);
    const planMatches = claim.existing_interval === interval && claim.existing_price_id === priceId;

    if (existing.status === "complete") {
      // Already succeeded -- creating another session would risk a second
      // subscription. Send it to the same place success_url would have,
      // carrying the real session id so the billing page can verify it
      // server-side (Finding 7) rather than trusting the query param alone.
      return `${siteUrl}/dashboard/billing?checkout=success&session_id=${existing.id}`;
    }

    if (existing.status === "open" && existing.url && planMatches) {
      if (claim.is_new_attempt) {
        // This reusable session belongs to a DIFFERENT (now-superseded)
        // attempt than the one just claimed -- re-home it under the
        // current attempt so the row stays internally consistent.
        const { data: recorded, error: recordError } = await admin.rpc("record_checkout_session", {
          p_organization_id: organizationId,
          p_attempt_id: attemptId,
          p_session_id: existing.id,
          p_lease_seconds: CHECKOUT_SESSION_LEASE_SECONDS,
        });
        if (recordError) {
          throw new Error(`Failed to re-home an existing checkout session for organization ${organizationId}: ${recordError.message}`);
        }
        if (!recorded) {
          throw new Error("A newer checkout attempt has since started for this organization -- try again.");
        }
      }
      return existing.url;
    }

    // Either Stripe reports this session 'expired', or it's still 'open'
    // but for a DIFFERENT plan than what's being requested now -- release
    // the stale attempt (clearing its session pointer) and claim a
    // genuinely fresh one, rather than waiting out the rest of its lease
    // or reusing a session for the wrong plan.
    const { error: releaseError } = await admin.rpc("release_checkout_attempt", {
      p_organization_id: organizationId,
      p_attempt_id: attemptId,
    });
    if (releaseError) {
      throw new Error(`Failed to release a stale checkout attempt for organization ${organizationId}: ${releaseError.message}`);
    }
    const { data: reclaimRows, error: reclaimError } = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: organizationId,
      p_interval: interval,
      p_price_id: priceId,
      p_mode: "subscription",
      p_claim_seconds: CHECKOUT_CLAIM_SECONDS,
    });
    if (reclaimError) {
      throw new Error(`Failed to re-claim a checkout attempt for organization ${organizationId}: ${reclaimError.message}`);
    }
    const reclaim = reclaimRows?.[0];
    if (!reclaim) {
      throw new Error(`claim_checkout_attempt returned no row for organization ${organizationId} on reclaim`);
    }
    attemptId = reclaim.attempt_id;
  } else if (!claim.is_new_attempt) {
    // A live attempt already owns this organization's checkout slot, mid
    // Stripe API round trip, with no session recorded yet -- don't race
    // ahead of it.
    throw new Error("A checkout attempt for this organization is already in progress -- try again in a moment.");
  }

  const customerId = await getOrCreateStripeCustomerId(organizationId, organizationName);
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: organizationId.toString(),
      line_items: [{ price: priceId, quantity: 1 }],
      // {CHECKOUT_SESSION_ID} is Stripe's own literal placeholder,
      // substituted with the real session id server-side on redirect --
      // Finding 7's mechanism for verifying the return trip server-side
      // instead of trusting the bare ?checkout=success query param.
      success_url: `${siteUrl}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
      metadata: { organization_id: organizationId.toString() },
      // Carried forward onto the Subscription object itself, not just
      // this Checkout Session -- the webhook handler reads it from every
      // subsequent subscription event (including ones from the customer
      // portal, which never goes through this action again).
      subscription_data: { metadata: { organization_id: organizationId.toString() } },
    },
    {
      // A STABLE key derived from the durable attempt id, not a
      // time-bucketed one -- a retry of the SAME attempt (its claim lease
      // still valid) reaches Stripe with the identical key and gets back
      // the SAME session object instead of creating a second one, even
      // after a crash between this call succeeding and its result being
      // persisted below.
      idempotencyKey: `checkout:attempt-${attemptId}`,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }

  const { data: recorded, error: recordError } = await admin.rpc("record_checkout_session", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_session_id: session.id,
    p_lease_seconds: CHECKOUT_SESSION_LEASE_SECONDS,
  });
  if (recordError) {
    throw new Error(`Failed to persist a created checkout session for organization ${organizationId}: ${recordError.message}`);
  }
  if (!recorded) {
    // Fenced out -- a newer attempt has since been claimed for this
    // organization. The just-created Stripe session is real but orphaned
    // from this app's own bookkeeping; harmless on its own (Checkout
    // Sessions expire unused, and completing one still activates the
    // organization via the webhook regardless of which local attempt row
    // tracked it) -- but this response must not be handed back to the
    // caller as if it were still the current attempt.
    throw new Error("A newer checkout attempt has since started for this organization -- try again.");
  }

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
    // Finding 6: fail closed before claiming any state if the live Stripe
    // configuration doesn't match what this page promises (wrong mode,
    // wrong currency/amount/interval, inactive price, mismatched product).
    await assertStripeConfigurationValid();

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
  } catch (err) {
    console.error(`createCheckoutSessionAction failed for organization ${organization.id}:`, err);
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
  } catch (err) {
    console.error(`createPortalSessionAction failed for organization ${organization.id}:`, err);
    target = "/dashboard/billing?error=portal_failed";
  }

  redirect(target);
}
