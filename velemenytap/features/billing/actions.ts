"use server";

import { redirect } from "next/navigation";
import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { hasLiveSubscription, canManageBilling } from "@/features/billing/status";
import { isBillingInterval, stripePriceId, type BillingInterval } from "@/features/billing/plans";
import { assertStripeConfigurationValid } from "@/features/billing/stripe-config";

// How long one checkout OPERATION owns its attempt before another may take
// the lease over. Must comfortably exceed the worst-case total time this
// action's own sequential Stripe calls could take -- see lib/stripe.ts's
// comment on the SDK's explicit timeout/retry budget. Correctness does not
// rest on this number alone (Finding 9): the lease is explicitly RENEWED
// at the checkpoint right before the slowest remaining call (session
// creation), so a single static duration only needs to cover the first leg.
//
// A created Session no longer needs a 24-hour lease of its own either: the
// ATTEMPT now outlives the operation (migration 20260908100000), so "there
// is a session in flight for this organization" is recorded by the attempt
// itself rather than by holding a day-long lock open.
const CHECKOUT_CLAIM_SECONDS = 150;

type ClaimResult = {
  attemptId: string;
  /** null when another operation currently holds this attempt's lease. */
  ownerToken: string | null;
  isNewAttempt: boolean;
  existingSessionId: string | null;
  existingInterval: string | null;
  existingPriceId: string | null;
  existingMode: string | null;
  /** The immutable request this attempt was created with, to replay verbatim. */
  request: Stripe.Checkout.SessionCreateParams | null;
  /** Whether this attempt's idempotency key is still inside Stripe's retention window. */
  retrySafe: boolean;
};

/**
 * The exact parameters sent to Stripe for a checkout attempt.
 *
 * Built once, then STORED (migration 20260908100000's checkout_request)
 * and replayed verbatim on every subsequent attempt sharing the same
 * idempotency key. Stripe rejects -- rather than deduplicates -- a retry
 * whose parameters differ from the original call under that key, so
 * re-deriving these values per attempt would make correctness depend on
 * NEXT_PUBLIC_SITE_URL, the price env vars, and this organization's own
 * row never changing in between. They are derived once and then frozen.
 */
function buildCheckoutRequest(
  organizationId: number,
  customerId: string,
  priceId: string,
  siteUrl: string,
): Stripe.Checkout.SessionCreateParams {
  return {
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
  };
}

/**
 * Refuses to replay a stored request that no longer describes what is
 * actually being asked for. The database validates the snapshot when it is
 * written; this is the matching check at the point of USE, so a request
 * stored against a customer or price that has since changed fails closed
 * rather than being sent to Stripe under an idempotency key that promises
 * it is identical to a previous call.
 */
function replayableRequest(
  stored: Stripe.Checkout.SessionCreateParams | null,
  customerId: string,
  priceId: string,
): Stripe.Checkout.SessionCreateParams | null {
  if (!stored) return null;
  const firstItem = Array.isArray(stored.line_items) ? stored.line_items[0] : undefined;
  if (stored.mode !== "subscription" || stored.customer !== customerId || firstItem?.price !== priceId) {
    return null;
  }
  return stored;
}

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
  request: Stripe.Checkout.SessionCreateParams,
): Promise<ClaimResult> {
  const { data, error } = await admin.rpc("claim_checkout_attempt", {
    p_organization_id: organizationId,
    p_interval: interval,
    p_price_id: priceId,
    p_request: request as unknown as Json,
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
    ownerToken: row.owner_token,
    isNewAttempt: row.is_new_attempt,
    existingSessionId: row.existing_session_id,
    existingInterval: row.existing_interval,
    existingPriceId: row.existing_price_id,
    existingMode: row.existing_mode,
    request: (row.request as unknown as Stripe.Checkout.SessionCreateParams | null) ?? null,
    retrySafe: row.retry_safe,
  };
}

async function renewAttempt(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
  ownerToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("renew_checkout_attempt", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_owner_token: ownerToken,
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
  ownerToken: string,
  sessionId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("record_checkout_session", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_owner_token: ownerToken,
    p_session_id: sessionId,
  });
  if (error) {
    throw new Error(`Failed to persist a created checkout session for organization ${organizationId}: ${error.message}`);
  }
  return data === true;
}

/**
 * Ends the operation while KEEPING the attempt: the customer has just been
 * handed a Stripe-hosted URL and may still be on it, so the attempt's
 * identity, its stored request and its recorded Session must survive --
 * only the lease is given up, so a later request need not wait it out.
 */
async function finishOperation(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
  ownerToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("finish_checkout_operation", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_owner_token: ownerToken,
  });
  if (error) {
    throw new Error(`Failed to finish the checkout operation for organization ${organizationId}: ${error.message}`);
  }
  return data === true;
}

async function releaseAttempt(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  attemptId: string,
  ownerToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_checkout_attempt", {
    p_organization_id: organizationId,
    p_attempt_id: attemptId,
    p_owner_token: ownerToken,
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
 * with a durable recovery step.
 *
 * R9 ledger correction: an earlier version of this comment said Search is
 * "the actual source of truth" consulted "before ever creating". Neither is
 * true of the code any more, and saying so invited exactly the mistake the
 * round-9 review had to catch twice. What actually happens:
 *
 *   * Inside the retry-safe window the frozen key IS the protection, and
 *     Search is not consulted at all -- consulting it there would be the
 *     read-after-write use Stripe explicitly rules out.
 *   * Outside it, Search is a positive-only probe (its documented weakness
 *     is staleness, so it can only produce false negatives), and creation is
 *     authorized solely by a COMPLETED `customers.list` enumeration over the
 *     bounded window the attempt could have created in.
 *   * Neither establishes that a CONCURRENT request will not create one a
 *     moment later -- that is what the creation lease is for (R9-03).
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

  const { data: claimRows, error: claimError } = await admin.rpc("claim_stripe_customer_creation", {
    p_organization_id: organizationId,
  });
  if (claimError) {
    throw new Error(`Failed to claim Stripe customer creation for organization ${organizationId}: ${claimError.message}`);
  }
  const claim = claimRows?.[0];
  if (!claim) {
    throw new Error(`claim_stripe_customer_creation returned no row for organization ${organizationId}`);
  }
  // Resolved by a concurrent caller between the read above and this claim.
  if (claim.customer_id) {
    return claim.customer_id;
  }
  // R9-03: another request is mid-creation for this organization. Standing
  // down is the point -- a fresh list cannot prove that an in-flight create
  // will not land a moment later, so racing it is exactly how two Customers
  // get made.
  if (!claim.owner_token) {
    throw new Error(
      `A Stripe customer is already being created for organization ${organizationId} -- try again in a moment.`,
    );
  }

  const creationOwner = claim.owner_token;
  let creationId = claim.creation_id!;
  let customerId: string;

  if (claim.retry_safe) {
    // Inside the frozen key's lifetime. Replaying create() under it either
    // returns the Customer a previous attempt already made, or makes the
    // first one -- Stripe decides, authoritatively, and no search is
    // involved at all. This is the case Stripe's own guidance rules out
    // solving with search ("don't use search in read-after-write flows").
    customerId = await createStripeCustomer(stripe, organizationId, creationId, organizationName);
  } else {
    // The key may have been pruned ("we generate a new request if a key is
    // reused after the original is pruned"), so replaying it could create a
    // SECOND Customer. Something else has to establish whether this
    // attempt already produced one -- and the two available mechanisms are
    // sound in opposite directions, so each is used only where it holds.
    const found = await findExistingCustomer(stripe, organizationId, claim.started_at);

    if (found.outcome === "found") {
      customerId = found.customer.id;
    } else if (found.outcome === "unknown") {
      // Ambiguous, so the attempt stays PENDING: its creation identity and
      // recorded timestamp are left exactly as they are, and a later
      // request (or the owner simply trying again) re-enters this same path
      // and re-checks. Nothing is created and nothing is rotated, because
      // this request cannot tell the difference between "no Customer
      // exists" and "one exists that I failed to observe."
      throw new Error(
        `Cannot establish whether organization ${organizationId} already has a Stripe customer from an earlier ` +
          `interrupted creation, and this attempt is too old for its idempotency key to be relied on. Leaving the ` +
          `attempt pending rather than risking a duplicate: ${found.reason}`,
      );
    } else {
      // outcome === "absent": a COMPLETED enumeration of the canonical list
      // endpoint over the whole window in which this attempt could have
      // created anything, which found nothing. That is a sound negative --
      // see findExistingCustomer for why an empty search alone is not.
      const { data: rotated, error: rotateError } = await admin.rpc("rotate_stripe_customer_creation", {
        p_organization_id: organizationId,
        p_creation_id: creationId,
        p_owner_token: creationOwner,
      });
      if (rotateError) {
        throw new Error(`Failed to rotate the Stripe customer creation key for organization ${organizationId}: ${rotateError.message}`);
      }
      if (!rotated) {
        // Someone else rotated or resolved it first -- re-resolve rather
        // than create under an identity this request no longer holds.
        return resolvePersistedCustomerId(admin, organizationId);
      }
      creationId = rotated;
      customerId = await createStripeCustomer(stripe, organizationId, creationId, organizationName);
    }
  }

  const { data: recorded, error: recordError } = await admin.rpc("record_stripe_customer", {
    p_organization_id: organizationId,
    p_creation_id: creationId,
    p_customer_id: customerId,
  });
  if (recordError) {
    throw new Error(`Failed to persist Stripe customer id for organization ${organizationId}: ${recordError.message}`);
  }
  if (recorded === true) {
    return customerId;
  }

  // The creation identity was superseded, or another caller recorded first.
  return resolvePersistedCustomerId(admin, organizationId);
}

// How far before the recorded attempt time the canonical enumeration starts,
// covering clock skew between this database and Stripe.
const CUSTOMER_PROBE_SLACK_MS = 5 * 60 * 1000;

// Pages of 100 the enumeration will walk before giving up. Hitting this cap
// means "I could not finish looking", which is deliberately NOT the same
// answer as "I looked everywhere and found nothing" -- see below.
const CUSTOMER_PROBE_MAX_PAGES = 20;

type CustomerProbe =
  | { outcome: "found"; customer: Stripe.Customer }
  | { outcome: "absent" }
  | { outcome: "unknown"; reason: string };

/**
 * Answers "did an earlier, interrupted attempt already create this
 * organization's Stripe Customer?" once the frozen idempotency key is too
 * old to answer it for us.
 *
 * The two mechanisms Stripe offers are sound in OPPOSITE directions, and
 * conflating them is what makes this dangerous:
 *
 *   * **Search** is an index Stripe explicitly documents as lagging -- "up
 *     to an hour behind during outages", and with no stated upper bound at
 *     all. Its failure mode is therefore *staleness*, which can only ever
 *     produce a FALSE NEGATIVE: it may fail to show a Customer that exists,
 *     but it will not invent one that doesn't. So a POSITIVE search result
 *     is trustworthy and is taken as proof; an EMPTY one proves nothing,
 *     however old the attempt is. "Old enough that it would surely be
 *     indexed by now" is an inference from a soft statement about typical
 *     behaviour, not a documented guarantee, and this code no longer
 *     authorizes creating a chargeable object on it.
 *
 *   * **List** is the canonical API read -- sorted by creation date,
 *     filterable by a `created` interval, and carrying none of search's
 *     consistency caveats. Walking it over the bounded window in which this
 *     attempt could possibly have created anything gives a NEGATIVE that
 *     actually means something. That enumeration is what authorizes
 *     creation; nothing else does.
 *
 * The window is bounded because the create() call either reached Stripe
 * within its own request lifetime or never did (`lib/stripe.ts` caps that
 * at a 20s timeout with 2 retries), so a Customer produced by this attempt
 * carries a `created` within minutes of the recorded attempt time. Rows
 * backfilled by migration 20260908120000 have a less precise recorded time,
 * so the window deliberately runs to the present for them rather than
 * assuming a tight bound -- at the cost of more pages, not of soundness.
 *
 * Anything that stops the enumeration finishing -- an API error, or more
 * pages than the cap -- returns "unknown", never "absent". The caller keeps
 * the attempt pending on "unknown". One extra retry for the organization is
 * a far cheaper mistake than a duplicate Customer that silently strands a
 * real payment.
 */
async function findExistingCustomer(
  stripe: Stripe,
  organizationId: number,
  attemptStartedAt: string | null,
): Promise<CustomerProbe> {
  const organizationTag = organizationId.toString();

  // Cheap positive-only probe first. A hit here is conclusive; a miss is
  // not, and deliberately does not short-circuit the enumeration below.
  try {
    const search = await stripe.customers.search({
      query: `metadata['organization_id']:'${organizationTag}'`,
      limit: 1,
    });
    const hit = search.data[0];
    if (hit) return { outcome: "found", customer: hit };
  } catch (err) {
    // Not fatal on its own: the canonical enumeration is what decides.
    console.error(
      `Stripe customer search failed for organization ${organizationId}; falling back to the canonical list ` +
        `enumeration: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!attemptStartedAt) {
    return { outcome: "unknown", reason: "no recorded creation-attempt time to bound the search window with" };
  }
  const startedAtMs = Date.parse(attemptStartedAt);
  if (Number.isNaN(startedAtMs)) {
    return { outcome: "unknown", reason: `unparseable creation-attempt time ${attemptStartedAt}` };
  }
  const createdGte = Math.floor((startedAtMs - CUSTOMER_PROBE_SLACK_MS) / 1000);

  let startingAfter: string | undefined;
  for (let page = 0; page < CUSTOMER_PROBE_MAX_PAGES; page++) {
    let batch: Stripe.ApiList<Stripe.Customer>;
    try {
      batch = await stripe.customers.list({
        created: { gte: createdGte },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    } catch (err) {
      return {
        outcome: "unknown",
        reason: `the canonical customer enumeration failed: ${err instanceof Error ? err.message : err}`,
      };
    }

    for (const candidate of batch.data) {
      if (candidate.metadata?.organization_id === organizationTag) {
        return { outcome: "found", customer: candidate };
      }
    }

    if (!batch.has_more) return { outcome: "absent" };
    startingAfter = batch.data[batch.data.length - 1]?.id;
    if (!startingAfter) return { outcome: "absent" };
  }

  return {
    outcome: "unknown",
    reason: `more than ${CUSTOMER_PROBE_MAX_PAGES * 100} customers created since this attempt -- enumeration did not complete`,
  };
}

/**
 * The idempotency key is derived from the durable creation identity, not
 * from the organization id, so retiring a dead key is expressible at all --
 * an org-derived key can never be rotated, which is what made the pruned-key
 * case unrecoverable before.
 *
 * `name` is mutable (an organization can rename itself between a first
 * attempt and a retry) and Stripe rejects a replay whose parameters differ,
 * so it is never passed inside the idempotency-guarded create() -- it is set
 * by a separate, ordinary update() afterwards, which carries no idempotency
 * constraint and is safe to repeat with whatever the current name is.
 */
/**
 * R9-04: a creation identity backfilled by migration 20260909120000 stands for
 * a key the PREVIOUS billing version already used -- `customer-create:org-ID`,
 * which was derived from the organization id rather than randomly. Replaying
 * the random replacement the first backfill invented would not have been a
 * replay at all, so Stripe would not have deduplicated it and an unrecorded
 * legacy Customer would have been duplicated. Mapping the sentinel back to the
 * original key makes the replay genuine.
 */
function idempotencyKeyFor(organizationId: number, creationId: string): string {
  return creationId === `legacy-org-${organizationId}`
    ? `customer-create:org-${organizationId}`
    : `customer-create:${creationId}`;
}

async function createStripeCustomer(
  stripe: Stripe,
  organizationId: number,
  creationId: string,
  organizationName: string,
): Promise<string> {
  const customer = await stripe.customers.create(
    { metadata: { organization_id: organizationId.toString() } },
    { idempotencyKey: idempotencyKeyFor(organizationId, creationId) },
  );
  try {
    await stripe.customers.update(customer.id, { name: organizationName });
  } catch (err) {
    console.error(`Failed to set the display name on Stripe customer ${customer.id}: ${err instanceof Error ? err.message : err}`);
  }
  return customer.id;
}

async function resolvePersistedCustomerId(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
): Promise<string> {
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
  ownerToken: string,
  priceId: string,
  siteUrl: string,
): Promise<ReconcileSessionOutcome> {
  const sessionId = claim.existingSessionId!;
  let existing = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });

  const actualPriceId = existing.line_items?.data[0]?.price?.id ?? null;
  const planMatches = actualPriceId === priceId;

  if (existing.status === "complete") {
    if (existing.payment_status === "paid" || existing.payment_status === "no_payment_required") {
      // The attempt is done with, but only reconciliation may clear it
      // (write_reconciliation_result does, on the billing page this URL
      // leads to). Release just the operation lease so a concurrent
      // request is not told "already in progress" for the next 150
      // seconds over an attempt nothing is still working on.
      await finishOperation(admin, organizationId, claim.attemptId, ownerToken);
      return { done: true, url: `${siteUrl}/dashboard/billing?checkout=success&session_id=${existing.id}` };
    }
    // Finding 8: complete but genuinely unpaid (still processing, or a
    // delayed payment method) -- release rather than trapping every
    // future attempt on this one dead-end Session.
    await releaseAttempt(admin, organizationId, claim.attemptId, ownerToken);
    return { done: false };
  }

  if (existing.status === "open" && existing.url && planMatches) {
    if (claim.isNewAttempt) {
      // A legacy attempt (one predating migration 20260908100000, with no
      // stored request) was replaced by a fresh one whose identity this
      // orphaned Session is not yet bound to. Binding it here is what
      // keeps the Session findable by the next attempt.
      const recorded = await recordSession(admin, organizationId, claim.attemptId, ownerToken, existing.id);
      if (!recorded) {
        throw new Error("A newer checkout attempt has since started for this organization -- try again.");
      }
    }
    await finishOperation(admin, organizationId, claim.attemptId, ownerToken);
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
      // The attempt is done with, but only reconciliation may clear it
      // (write_reconciliation_result does, on the billing page this URL
      // leads to). Release just the operation lease so a concurrent
      // request is not told "already in progress" for the next 150
      // seconds over an attempt nothing is still working on.
      await finishOperation(admin, organizationId, claim.attemptId, ownerToken);
      return { done: true, url: `${siteUrl}/dashboard/billing?checkout=success&session_id=${existing.id}` };
    }
  }

  // R9-01 (independent round-9 review, P1). Releasing the attempt is what
  // permits the caller to create a REPLACEMENT Session, so it may only
  // happen once this one is confirmed to have left the payable state.
  //
  // The block above tries to expire an open Session, but expire() can throw
  // (a Stripe incident, a timeout) and the follow-up retrieve() can fail
  // too. Both of those used to fall through to the release below, which
  // handed the customer a second payable URL while the first was still
  // open -- exactly the duplicate-subscription outcome the expire call
  // exists to prevent. The comment claimed the guarantee; the code did not
  // check for it.
  //
  // `open` is the only payable state, so the test is simply whether we
  // OBSERVED it leaving. `expired` and `complete` are both terminal for
  // payment purposes -- a complete-but-unpaid Session cannot be paid again
  // either, and the subscription it may have created is picked up by
  // reconciliation, not by this path. Anything still open, or unknown
  // because we could not read it, fails closed: the attempt and its
  // recorded Session are kept, and the next request re-checks them.
  if (existing.status === "open") {
    throw new Error(
      `Could not confirm that the previous Checkout Session for organization ${organizationId} is no longer ` +
        "payable, so a replacement was not created -- try again in a moment.",
    );
  }

  await releaseAttempt(admin, organizationId, claim.attemptId, ownerToken);
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

  // The immutable request snapshot names the Stripe Customer, and the
  // database refuses a snapshot whose customer doesn't match this row's
  // own -- so the customer has to be resolved BEFORE the attempt can be
  // claimed. Doing it outside the attempt lease is safe: this call is
  // idempotent and recovers an existing customer from Stripe itself
  // rather than creating a second one (see its own doc comment).
  const customerId = await getOrCreateStripeCustomerId(organizationId, organizationName);
  const request = buildCheckoutRequest(organizationId, customerId, priceId, siteUrl);

  let claim = await claimAttempt(admin, organizationId, interval, priceId, request);
  if (!claim.ownerToken) {
    // Another request holds a live operation lease, mid Stripe round trip
    // -- don't race ahead of it.
    throw new Error("A checkout attempt for this organization is already in progress -- try again in a moment.");
  }

  if (claim.existingSessionId) {
    const outcome = await reconcileExistingSession(
      stripe,
      admin,
      organizationId,
      claim,
      claim.ownerToken,
      priceId,
      siteUrl,
    );
    if (outcome.done) {
      return outcome.url;
    }
    // The prior attempt was released -- claim fresh. Reusing the SAME
    // claim object here would risk operating on a now-stale attempt id.
    claim = await claimAttempt(admin, organizationId, interval, priceId, request);
    if (!claim.ownerToken || claim.existingSessionId) {
      // Should not normally happen immediately after a release -- fail
      // closed rather than loop indefinitely.
      throw new Error("Unable to obtain a clean checkout attempt for this organization -- try again.");
    }
  } else if (!claim.isNewAttempt && (claim.existingPriceId !== priceId || !claim.retrySafe)) {
    // Taking over an attempt that recorded no Session, and that is either
    // for a different plan than the one now requested, or old enough that
    // Stripe may no longer remember its idempotency key (so replaying it
    // would no longer be deduplicated).
    //
    // R9 ledger correction: this used to add "and any unrecorded Session it
    // could have created has expired on Stripe's side by then anyway."
    // That conflated the ATTEMPT's age with the SESSION's expiry. They are
    // different clocks -- this app sets no explicit `expires_at`, so Stripe's
    // default is 24 hours from SESSION creation, not from when the attempt
    // was minted. The claim was not established and is withdrawn. What is
    // actually true is narrower: there is no RECORDED Session to lose here,
    // so discarding the attempt costs nothing that this app can see.
    await releaseAttempt(admin, organizationId, claim.attemptId, claim.ownerToken);
    claim = await claimAttempt(admin, organizationId, interval, priceId, request);
    if (!claim.ownerToken) {
      throw new Error("Unable to obtain a clean checkout attempt for this organization -- try again.");
    }
  }

  const attemptId = claim.attemptId;
  const ownerToken = claim.ownerToken;

  // Replay the attempt's OWN stored request, not a freshly built one --
  // that is what makes the idempotency key below meaningful across a
  // takeover. A stored request that no longer describes this claim is
  // refused rather than sent (see replayableRequest).
  const payload = claim.isNewAttempt
    ? request
    : replayableRequest(claim.request, customerId, priceId);
  if (!payload) {
    throw new Error("The stored checkout request no longer matches this organization's plan -- try again.");
  }

  // Finding 9: renew immediately before the (potentially slow) Checkout
  // Session creation call, proving this request still owns the attempt --
  // correctness no longer depends on the FULL request (customer
  // resolution included) finishing inside one static claim window.
  const stillOwned = await renewAttempt(admin, organizationId, attemptId, ownerToken);
  if (!stillOwned) {
    throw new Error("This checkout attempt expired before it could be completed -- try again.");
  }

  const session = await stripe.checkout.sessions.create(payload, {
    // A STABLE key derived from the durable attempt id -- which now
    // survives lease expiry (migration 20260908100000), so a takeover
    // reaches Stripe with the identical key and gets back the SAME
    // session object instead of creating a second one.
    idempotencyKey: `checkout:attempt-${attemptId}`,
  });

  // Recorded BEFORE anything about the Session is validated. A Session
  // that exists at Stripe but was never written down here is invisible to
  // every later attempt -- which is exactly how a customer ends up with
  // two. Whatever is wrong with it can be discovered afterwards; its
  // existence cannot be discovered afterwards.
  const recorded = await recordSession(admin, organizationId, attemptId, ownerToken, session.id);
  if (!recorded) {
    throw new Error("A newer checkout attempt has since started for this organization -- try again.");
  }

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }

  // The operation ends here; the ATTEMPT deliberately does not. The
  // customer is about to be sent to Stripe's hosted page and may take
  // minutes on it -- the attempt (and its recorded Session) must outlive
  // this request so the next one reconciles rather than duplicates.
  await finishOperation(admin, organizationId, attemptId, ownerToken);

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
