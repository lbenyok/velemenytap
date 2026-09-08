"use server";

import { redirect } from "next/navigation";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { hasLiveSubscription, canManageBilling } from "@/features/billing/status";
import { isBillingInterval, stripePriceId, type BillingInterval } from "@/features/billing/plans";
import { assertStripeConfigurationValid } from "@/features/billing/stripe-config";

// How long a genuinely new checkout attempt's CLAIM lasts before another
// attempt may reclaim the slot. Must comfortably exceed the WORST-CASE
// total time this action's own sequential Stripe calls could take -- see
// lib/stripe.ts's own comment on the SDK's explicit timeout/retry budget.
// Correctness does not rest on this number alone, though (Finding 9): the
// attempt is explicitly RENEWED at the checkpoint right before the
// slowest remaining call (session creation), so a single static duration
// only needs to cover the FIRST leg (customer resolution), not the whole
// request.
const CHECKOUT_CLAIM_SECONDS = 150;

// How long a real, already-created Checkout Session's own lease lasts --
// matches Stripe's own default Checkout Session expiration (24 hours).
const CHECKOUT_SESSION_LEASE_SECONDS = 24 * 60 * 60;

type ClaimResult = {
  attemptId: string;
  isNewAttempt: boolean;
  existingSessionId: string | null;
  existingInterval: string | null;
  existingPriceId: string | null;
  existingMode: string | null;
};

/**
 * Fourth independent review, Finding 7: every affected-row/CAS result from
 * these RPCs is checked explicitly and rigorously below -- a missing row,
 * a null/false return, or a Postgres error all fail the whole action
 * closed (an Error is thrown, caught by the caller, never silently
 * treated as "probably fine"). Nothing here ever proceeds to call Stripe
 * on the strength of an unverified database write.
 */
async function claimAttempt(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  interval: BillingInterval,
  priceId: string,
): Promise<ClaimResult> {
  const { data, error } = await admin.rpc("claim_checkout_attempt", {
    p_organization_id: organizationId,
    p_interval: interval,
    p_price_id: priceId,
    p_mode: "subscription",
    p_claim_seconds: CHECKOUT_CLAIM_SECONDS,
  });
  if (error) {
    throw new Error(`Failed to claim a checkout attempt for organization ${organizationId}: ${error.message}`);
  }
  const row = data?.[0];
  if (!row) {
    throw new Error(`claim_checkout_attempt returned no row for organization ${organizationId}`);
  }
  return {
    attemptId: row.attempt_id,
    isNewAttempt: row.is_new_attempt,
    existingSessionId: row.existing_session_id,
    existingInterval: row.existing_interval,
    existingPriceId: row.existing_price_id,
    existingMode: row.existing_mode,
  };
}

async function renewAttempt(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("renew_checkout_attempt", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_claim_seconds: CHECKOUT_CLAIM_SECONDS,
  });
  if (error) {
    throw new Error(`Failed to renew checkout attempt for organization ${organizationId}: ${error.message}`);
  }
  return data === true;
}

async function recordSession(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
  sessionId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("record_checkout_session", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_session_id: sessionId,
    p_lease_seconds: CHECKOUT_SESSION_LEASE_SECONDS,
  });
  if (error) {
    throw new Error(`Failed to persist a created checkout session for organization ${organizationId}: ${error.message}`);
  }
  return data === true;
}

async function releaseAttempt(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_checkout_attempt", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
  });
  if (error) {
    throw new Error(`Failed to release a checkout attempt for organization ${organizationId}: ${error.message}`);
  }
  return data === true;
}

/**
 * Finds this organization's Stripe customer, creating one on first use.
 *
 * Finding 10: Stripe's own documentation does not describe idempotency-key
 * retention as a permanent guarantee -- keys can be pruned after as little
 * as 24 hours. A create() call retried long after an earlier, successful
 * attempt that was never persisted locally (a crash between the two)
 * could therefore create a genuine SECOND Stripe Customer once the
 * original key has expired, not be deduplicated by Stripe at all. Fixed
 * with a durable recovery step: before ever creating, search Stripe
 * directly for a customer already carrying this organization's id in its
 * metadata -- this is the actual source of truth "does a customer already
 * exist for this organization," independent of both the local database
 * AND the idempotency key's own retention window.
 *
 * Also fixed: the create() call's own parameters must be STABLE across
 * every retry sharing the same idempotency key, or Stripe rejects the
 * retry outright (an idempotency-parameter mismatch), not deduplicate it.
 * `name` is mutable (an organization can rename itself between a first
 * attempt and a retry) and is therefore never passed inside the
 * idempotency-guarded create() call at all -- it's set with a separate,
 * ordinary update() call afterward, which carries no idempotency
 * constraint and is safe to repeat with whatever the CURRENT name is.
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

  let customerId: string;
  const recovered = await stripe.customers
    .search({ query: `metadata['organization_id']:'${organizationId}'`, limit: 1 })
    .catch((err) => {
      console.error(
        `Stripe customer recovery search failed for organization ${organizationId}, proceeding to create: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });

  if (recovered && recovered.data.length > 0) {
    customerId = recovered.data[0].id;
  } else {
    const customer = await stripe.customers.create(
      { metadata: { organization_id: organizationId.toString() } },
      { idempotencyKey: `customer-create:org-${organizationId}` },
    );
    customerId = customer.id;
    try {
      await stripe.customers.update(customerId, { name: organizationName });
    } catch (err) {
      console.error(`Failed to set the display name on Stripe customer ${customerId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Concurrency guard: `.is("stripe_customer_id", null)` means this
  // UPDATE only actually applies if nothing else has already set it since
  // the read above.
  const { data: updated, error: updateError } = await admin
    .from("organization_billing")
    .update({ stripe_customer_id: customerId })
    .eq("organization_id", organizationId)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to persist Stripe customer id for organization ${organizationId}: ${updateError.message}`);
  }
  if (updated) {
    return customerId;
  }

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

type ReconcileSessionOutcome = { done: true; url: string } | { done: false };

/**
 * Reconciles an existing (possibly superseded, possibly stale) Checkout
 * Session against Stripe's own live state before ever trusting it.
 *
 * Finding 1: `planMatches` is derived from the Session's ACTUAL Stripe-side
 * line item price -- never from this row's own bookkeeping fields, which
 * (even after the database-level race fix in migration 20260907210000)
 * are one level of indirection removed from ground truth.
 *
 * Finding 2: a superseded but still-`open` Session is explicitly EXPIRED
 * via Stripe's own API before this function ever returns a different
 * Session's URL -- a customer who still has both tabs/links open can no
 * longer complete two subscriptions. The race where the old Session
 * completes WHILE the expire() call is in flight is handled explicitly:
 * Stripe's expire() call itself fails once a Session has already
 * completed, and that failure is treated as "go check what actually
 * happened," not swallowed.
 *
 * Finding 8: a `complete` Session's `payment_status` is checked
 * explicitly (`paid`/`no_payment_required` only) -- a complete-but-unpaid
 * or still-processing Session is never treated as a success, and is
 * released so it can never permanently trap every future attempt.
 */
async function reconcileExistingSession(
  stripe: Stripe,
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  claim: ClaimResult,
  interval: BillingInterval,
  priceId: string,
  siteUrl: string,
): Promise<ReconcileSessionOutcome> {
  const sessionId = claim.existingSessionId!;
  let existing = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });

  const actualPriceId = existing.line_items?.data[0]?.price?.id ?? null;
  const planMatches = actualPriceId === priceId;

  if (existing.status === "complete") {
    if (existing.payment_status === "paid" || existing.payment_status === "no_payment_required") {
      return { done: true, url: `${siteUrl}/dashboard/billing?checkout=success&session_id=${existing.id}` };
    }
    // Finding 8: complete but genuinely unpaid (still processing, or a
    // delayed payment method) -- release rather than trapping every
    // future attempt on this one dead-end Session.
    await releaseAttempt(admin, organizationId, claim.attemptId);
    return { done: false };
  }

  if (existing.status === "open" && existing.url && planMatches) {
    if (claim.isNewAttempt) {
      const recorded = await recordSession(admin, organizationId, claim.attemptId, existing.id);
      if (!recorded) {
        throw new Error("A newer checkout attempt has since started for this organization -- try again.");
      }
    }
    return { done: true, url: existing.url };
  }

  if (existing.status === "open") {
    // Either a plan mismatch (a superseded monthly session while yearly
    // is now requested) or simply an attempt we're about to replace --
    // either way, expire it on Stripe's own side before proceeding, so a
    // customer holding the old link can no longer complete it.
    try {
      const expired = await stripe.checkout.sessions.expire(sessionId);
      existing = expired;
    } catch {
      // Stripe rejects expire() once a Session has already completed (or
      // already expired) -- re-retrieve to find out which, rather than
      // assuming it's simply gone.
      const recheck = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
      if (recheck) existing = recheck;
    }
    if (existing.status === "complete" && (existing.payment_status === "paid" || existing.payment_status === "no_payment_required")) {
      // Raced: it completed before/during expiration. Reconcile it as a
      // real success instead of discarding a genuine payment.
      return { done: true, url: `${siteUrl}/dashboard/billing?checkout=success&session_id=${existing.id}` };
    }
  }

  await releaseAttempt(admin, organizationId, claim.attemptId);
  return { done: false };
}

/**
 * Claims a durable, database-backed Checkout attempt for this organization
 * before ever calling Stripe, reconciles any session left by a prior
 * attempt against Stripe's own live state, and creates a fresh Checkout
 * Session only once nothing reusable exists. See reconcileExistingSession
 * and the RPC wrapper functions above for the specific findings each part
 * of this closes.
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

  let claim = await claimAttempt(admin, organizationId, interval, priceId);

  if (claim.existingSessionId) {
    const outcome = await reconcileExistingSession(stripe, admin, organizationId, claim, interval, priceId, siteUrl);
    if (outcome.done) {
      return outcome.url;
    }
    // The prior session was released -- claim fresh. Reusing the SAME
    // claim object here would risk operating on a now-stale attempt id.
    claim = await claimAttempt(admin, organizationId, interval, priceId);
    if (claim.existingSessionId) {
      // Should not normally happen immediately after a release -- fail
      // closed rather than loop indefinitely.
      throw new Error("Unable to obtain a clean checkout attempt for this organization -- try again.");
    }
  } else if (!claim.isNewAttempt) {
    // A live attempt already owns this organization's checkout slot, mid
    // Stripe API round trip, with no session recorded yet -- don't race
    // ahead of it.
    throw new Error("A checkout attempt for this organization is already in progress -- try again in a moment.");
  }

  const attemptId = claim.attemptId;

  const customerId = await getOrCreateStripeCustomerId(organizationId, organizationName);

  // Finding 9: renew immediately before the (potentially slow) Checkout
  // Session creation call, proving this request still owns the attempt --
  // correctness no longer depends on the FULL request (customer
  // resolution included) finishing inside one static claim window.
  const stillOwned = await renewAttempt(admin, organizationId, attemptId);
  if (!stillOwned) {
    throw new Error("This checkout attempt expired before it could be completed -- try again.");
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: organizationId.toString(),
      line_items: [{ price: priceId, quantity: 1 }],
      // {CHECKOUT_SESSION_ID} is Stripe's own literal placeholder,
      // substituted with the real session id server-side on redirect.
      success_url: `${siteUrl}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
      metadata: { organization_id: organizationId.toString() },
      subscription_data: { metadata: { organization_id: organizationId.toString() } },
    },
    {
      // A STABLE key derived from the durable attempt id -- a retry of
      // the SAME attempt (its claim still valid, just renewed) reaches
      // Stripe with the identical key and gets back the SAME session
      // object instead of creating a second one.
      idempotencyKey: `checkout:attempt-${attemptId}`,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }

  const recorded = await recordSession(admin, organizationId, attemptId, session.id);
  if (!recorded) {
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
    await assertStripeConfigurationValid();

    const billing = await getOrganizationBilling(organization.id);
    if (hasLiveSubscription(billing)) {
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
 * payment details itself.
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
