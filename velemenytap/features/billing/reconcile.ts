import "server-only";

import type Stripe from "stripe";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BillingStatus, Json } from "@/lib/supabase/database.types";
import { approvedPriceIds } from "@/features/billing/stripe-config";

/**
 * Fourth independent review, Finding 5: "Create one shared, idempotent
 * reconciliation service used by: subscription webhooks; the verified
 * Checkout-success return; an authenticated administrator repair path;
 * and a monitored scheduled reconciliation mechanism." This file is that
 * service. Every caller (app/api/webhooks/stripe/route.ts,
 * app/dashboard/billing/page.tsx's pending-state handling,
 * features/billing/admin-actions.ts's self-service repair, and
 * app/api/admin/reconcile-billing-sweep/route.ts's scheduled sweep) goes through
 * `reconcileOrganizationBilling` -- there is exactly one implementation of
 * "re-derive this organization's entitlement from Stripe," not four
 * slightly-different ones that could quietly drift apart.
 *
 * Finding 3: replaces the previous billing_sync_seq claim-order fencing
 * (proven invalid by an independent adversarial review -- a request that
 * claims an earlier sequence number can still execute, and observe
 * genuinely fresher Stripe state, AFTER a later-sequenced request has
 * already written, and the old design discarded that fresher read purely
 * because of claim order) with an EXCLUSIVE, expiring reconciliation
 * lease (claim_reconciliation_lease/write_reconciliation_result/
 * release_reconciliation_lease, migration 20260907210000): only one
 * reconciler may hold an organization's lease at a time, claimed BEFORE
 * any Stripe network call, so there is no window where two readers can
 * observe Stripe state concurrently and race to write at all -- mutual
 * exclusion, not fencing after the fact.
 *
 * A contender that cannot claim the lease -- or claims it but loses it
 * before writing -- NEVER silently assumes someone else's write already
 * covers it. needs_reconciliation is set durably (by the database
 * functions themselves, in the same statement) whenever that happens, so
 * this organization is never permanently dropped even if every webhook
 * for it is eventually missed: the scheduled sweep finds it later.
 *
 * Fifth round, migration 20260908110000 -- generation counters. Mutual
 * exclusion alone still lost an event that arrived DURING a reconciliation:
 * the losing racer set the dirty flag, and the winner's own completing
 * write then cleared it, discarding the only record that a newer event
 * existed. Every entry point here registers its obligation FIRST, committing
 * a monotonic generation before any AUTHORITATIVE Stripe call;
 * claim_reconciliation_lease reports the generation it observed, and a
 * completing write may clear the dirty flag only if no higher generation has
 * been requested since. A write answers "was every request I knew about
 * satisfied," not merely "did I finish."
 *
 * R9 ledger correction: this used to say "before any Stripe call", which was
 * too broad -- the webhook route retrieves an object to resolve which
 * organization an event belongs to before it ever reaches this service. That
 * retrieval decides identity, not entitlement, and the authoritative
 * subscription list happens after the lease is held, which is the property
 * that actually matters.
 *
 * R9-02: there are TWO obligations, and they are counted separately --
 * refreshing subscription state, and persisting a paid activation. A writer
 * may only advance the counter for the work it actually performed, because
 * one shared counter let either kind mark the other kind's pending requests
 * complete. A subscription refresh that observes an `active` status does
 * additionally discharge the activation obligation, since an active
 * subscription IS the evidence that a payment succeeded -- without that, an
 * organization whose invoice event was never redelivered would stay dirty
 * forever with nothing able to satisfy it.
 */

// R9-07: how many 100-item pages of subscription history one reconciliation
// will walk before refusing to decide entitlement from a prefix.
const SUBSCRIPTION_PAGE_CAP = 20;

const LIVE_STRIPE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
]);

const RECOVERABLE_STRIPE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "past_due",
  "incomplete",
  "unpaid",
  "paused",
]);

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

function newestOf(subscriptions: Stripe.Subscription[]): Stripe.Subscription {
  return subscriptions.reduce((newest, s) => (s.created > newest.created ? s : newest));
}

// Only the first line item is inspected -- this app's own Checkout flow
// (features/billing/actions.ts) always creates single-item subscriptions,
// so this is unreachable through this app's own code paths today. Flagged
// during this round's own independent adversarial audit as having no
// defense if a multi-item subscription is ever created directly via the
// Stripe Dashboard or Portal, where entitlement would then hinge on item
// ordering Stripe doesn't formally guarantee -- revisit if this app ever
// sells more than one line item per subscription.
export function subscriptionPriceId(subscription: Stripe.Subscription): string | null {
  const price = subscription.items.data[0]?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

/**
 * Finding 4: multi-subscription selection. An active/trialing VéleményTap
 * subscription ALWAYS wins over a newer incomplete/past_due/unpaid/paused
 * one -- a payment failure on a SECOND, later subscription attempt must
 * never lock out a customer whose original subscription is still genuinely
 * active. Only among subscriptions of the SAME tier (all live, or all
 * recoverable-but-not-live, or all terminal) does "most recently created"
 * break the tie.
 *
 * Finding 11: only subscriptions whose primary item price is one of this
 * app's own approved Price ids are considered for entitlement at all --
 * a subscription attached to some other Product/Price on the same Stripe
 * Customer (a data-integrity anomaly, a forged/foreign attachment) is
 * excluded from the pool entirely, not merely de-prioritized, and reported
 * as an anomaly by the caller.
 *
 * Returns the subscription that should currently govern entitlement (or
 * null if none of the approved-price subscriptions are usable), plus
 * every approved-price subscription considered (for duplicate-active
 * detection) and every subscription that was excluded as unapproved (for
 * anomaly reporting).
 */
export function pickCurrentSubscription(
  subscriptions: Stripe.Subscription[],
  approvedPrices: ReadonlySet<string> = approvedPriceIds(),
): {
  current: Stripe.Subscription | null;
  approved: Stripe.Subscription[];
  unapproved: Stripe.Subscription[];
  duplicateActive: Stripe.Subscription[];
} {
  const approved: Stripe.Subscription[] = [];
  const unapproved: Stripe.Subscription[] = [];
  for (const s of subscriptions) {
    const priceId = subscriptionPriceId(s);
    if (priceId && approvedPrices.has(priceId)) {
      approved.push(s);
    } else {
      unapproved.push(s);
    }
  }

  if (approved.length === 0) {
    return { current: null, approved, unapproved, duplicateActive: [] };
  }

  const live = approved.filter((s) => LIVE_STRIPE_STATUSES.has(s.status));
  if (live.length > 0) {
    return { current: newestOf(live), approved, unapproved, duplicateActive: live.length > 1 ? live : [] };
  }

  const recoverable = approved.filter((s) => RECOVERABLE_STRIPE_STATUSES.has(s.status));
  const pool = recoverable.length > 0 ? recoverable : approved;
  return { current: newestOf(pool), approved, unapproved, duplicateActive: [] };
}

export async function recordAnomaly(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: number,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.rpc("record_billing_anomaly", {
    p_organization_id: organizationId,
    p_kind: kind,
    p_detail: detail as Json,
  });
  if (error) {
    console.error(`Failed to record billing anomaly "${kind}" for organization ${organizationId}: ${error.message}`);
  }
}

export type ReconcileOutcome =
  | { outcome: "reconciled"; subscriptionId: string; status: BillingStatus }
  | { outcome: "no_subscriptions" }
  | { outcome: "deferred" }
  | { outcome: "error"; message: string };

/**
 * Re-derives and applies an organization's CURRENT Stripe entitlement from
 * scratch -- idempotent, safe to call redundantly (a duplicate webhook
 * delivery, a page load racing a webhook, a scheduled sweep re-checking
 * an organization that's already current all produce the same result).
 *
 * `outcome: "deferred"` means another reconciler currently holds this
 * organization's lease (or took it away mid-flight) -- NOT a failure. The
 * organization has been durably marked needs_reconciliation by the
 * database function itself; the caller may retry, or simply let the
 * scheduled sweep pick it up later. It must never be treated as "this
 * event's effect is already covered," since that assumption is exactly
 * what Finding 3 proved unsafe.
 */
export async function reconcileOrganizationBilling(
  organizationId: number,
  stripeCustomerId: string,
): Promise<ReconcileOutcome> {
  const admin = createAdminClient();
  const stripe = createStripeClient();

  // Record that reconciliation is WANTED before anything else -- durably,
  // and independently of whether this request goes on to win the lease.
  // This is the half of the generation pair that makes a losing racer's
  // event survive: whoever currently holds the lease cannot mark this
  // organization clean without also having satisfied this request.
  const { error: requestError } = await admin.rpc("request_billing_reconciliation", {
    p_organization_id: organizationId,
  });
  if (requestError) {
    return { outcome: "error", message: `Failed to request reconciliation: ${requestError.message}` };
  }

  const { data: claim, error: claimError } = await admin.rpc("claim_reconciliation_lease", {
    p_organization_id: organizationId,
  });
  if (claimError) {
    return { outcome: "error", message: `Failed to claim reconciliation lease: ${claimError.message}` };
  }
  const lease = claim?.[0];
  if (!lease) {
    return { outcome: "deferred" };
  }
  const owner = lease.owner_token;
  const generation = lease.requested_generation;
  // R9-02: the activation generation is carried through untouched by this
  // path except when an `active` status discharges it -- a subscription
  // refresh must never mark an activation obligation done on its own.
  const activationGeneration = lease.activation_generation;

  try {
    let subscriptions: Stripe.Subscription[];
    try {
      // R9-07 (round-9 review): a single page was treated as the customer's
      // whole subscription history. `limit` is a page size, not a total, and
      // `has_more` was ignored -- so an older but still ACTIVE subscription
      // sitting behind 100 newer terminal ones would never be seen, and
      // pickCurrentSubscription would write a canceled entitlement for a
      // customer who is actually paying. Page through until Stripe says
      // there is no more.
      //
      // Bounded so an anomalous history cannot make a reconciliation run
      // unboundedly: exhausting the cap is NOT treated as "this is the whole
      // set", it fails the reconciliation, which leaves the organization
      // dirty for the sweep rather than deciding entitlement on a prefix.
      subscriptions = [];
      let startingAfter: string | undefined;
      let pages = 0;
      for (;;) {
        const list: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: "all",
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        subscriptions.push(...list.data);
        if (!list.has_more) break;
        if (++pages >= SUBSCRIPTION_PAGE_CAP) {
          throw new Error(
            `more than ${SUBSCRIPTION_PAGE_CAP * 100} subscriptions for customer ${stripeCustomerId} -- refusing to ` +
              "decide entitlement from a partial history",
          );
        }
        startingAfter = list.data[list.data.length - 1]?.id;
        if (!startingAfter) break;
      }
    } catch (err) {
      const message = `Failed to list Stripe subscriptions: ${err instanceof Error ? err.message : err}`;
      await admin.rpc("fail_billing_reconciliation", {
        p_organization_id: organizationId,
        p_owner: owner,
        p_error: message,
      });
      return { outcome: "error", message };
    }

    const { current, unapproved, duplicateActive } = pickCurrentSubscription(subscriptions);

    if (unapproved.length > 0) {
      await recordAnomaly(admin, organizationId, "unapproved_subscription", {
        subscriptionIds: unapproved.map((s) => s.id),
        priceIds: unapproved.map((s) => subscriptionPriceId(s)),
      });
    }
    if (duplicateActive.length > 1) {
      await recordAnomaly(admin, organizationId, "duplicate_active_subscriptions", {
        subscriptionIds: duplicateActive.map((s) => s.id),
      });
      console.error(
        `Organization ${organizationId} has ${duplicateActive.length} simultaneously active/trialing subscriptions: ` +
          `${duplicateActive.map((s) => s.id).join(", ")} -- picked the most recently created; needs manual review.`,
      );
    }

    if (!current) {
      // Found during this round's own independent adversarial audit: when
      // subscriptions exist but NONE are approved (approved.length === 0,
      // unapproved.length > 0 -- e.g. the organization's previously-live
      // subscription was moved to a different Product/Price entirely,
      // whether through the Stripe Billing Portal or a manual Stripe-side
      // change), simply releasing the lease here left this row's
      // stripe_subscription_id/status frozen at whatever they were BEFORE
      // -- a previously "active" organization stayed "active" forever,
      // even though Stripe no longer reports any subscription this app
      // actually sells. That directly contradicted this file's own
      // "guaranteed convergence" claim for exactly this case.
      //
      // Only revoke when there is actually something tracked to revoke,
      // though: an organization still on its own pre-signup trial
      // (stripe_customer_id resolved, but no subscription has EVER been
      // approved for it -- persisted stripe_subscription_id still null)
      // must not have its trial status overwritten just because an
      // unrelated/unapproved subscription happens to exist on the same
      // Stripe Customer.
      if (unapproved.length > 0) {
        const { data: persisted } = await admin
          .from("organization_billing")
          .select("stripe_subscription_id")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (persisted?.stripe_subscription_id) {
          const { data: applied, error: writeError } = await admin.rpc("write_reconciliation_result", {
            p_organization_id: organizationId,
            p_owner: owner,
            p_requested_generation: generation,
            p_activation_generation: activationGeneration,
            p_stripe_customer_id: stripeCustomerId,
            p_stripe_subscription_id: null,
            p_status: "canceled",
            p_current_period_end: null,
            p_cancel_at_period_end: false,
          });
          if (writeError) {
            return { outcome: "error", message: `Failed to revoke stale entitlement: ${writeError.message}` };
          }
          if (!applied) {
            return { outcome: "deferred" };
          }
          return { outcome: "no_subscriptions" };
        }
      }
      // Genuinely nothing to reconcile (no subscriptions at all, or only
      // unapproved ones with nothing previously tracked to revoke) --
      // this is a CONFIRMED-CLEAN outcome, not an error or an abandoned
      // attempt. Found during this round's own independent adversarial
      // audit: release_reconciliation_lease is the error/abandonment
      // cleanup path and unconditionally re-marks the organization dirty
      // in the same statement regardless of why it's called -- using it
      // here left every organization that ever reached this branch
      // permanently flagged needs_reconciliation, re-polled by the
      // scheduled sweep every 15 minutes forever with nothing to actually
      // do. clear_reconciliation_dirty (migration 20260907240000) is the
      // distinct function for this distinct case: releases the lease
      // without re-marking dirty.
      await admin.rpc("clear_reconciliation_dirty", {
        p_organization_id: organizationId,
        p_owner: owner,
        p_requested_generation: generation,
        p_activation_generation: activationGeneration,
      });
      return { outcome: "no_subscriptions" };
    }

    const item = current.items.data[0];
    const status = toBillingStatus(current.status);
    const { data: applied, error: writeError } = await admin.rpc("write_reconciliation_result", {
      p_organization_id: organizationId,
      p_owner: owner,
      p_requested_generation: generation,
      p_activation_generation: activationGeneration,
      p_stripe_customer_id: stripeCustomerId,
      p_stripe_subscription_id: current.id,
      p_status: status,
      p_current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
      p_cancel_at_period_end: current.cancel_at_period_end,
    });
    if (writeError) {
      return { outcome: "error", message: `Failed to write reconciliation result: ${writeError.message}` };
    }
    if (!applied) {
      // The lease was lost between claiming it and writing (expired, or
      // reclaimed) -- write_reconciliation_result already re-marked the
      // organization dirty in the same statement. Not a failure to
      // surface as an error; just not yet done.
      return { outcome: "deferred" };
    }

    return { outcome: "reconciled", subscriptionId: current.id, status };
  } catch (err) {
    try {
      await admin.rpc("release_reconciliation_lease", { p_organization_id: organizationId, p_owner: owner });
    } catch {
      // Best-effort cleanup only -- the lease's own expiry is the fallback.
    }
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finding 5/11: the invoice.paid activation path, under the SAME lease
 * discipline as reconcileOrganizationBilling -- an invoice.paid event
 * competing with a concurrent subscription sync for the same organization
 * is mutually excluded too, not independently fenced by a second
 * mechanism. Idempotent (activated_at only ever transitions null -> a
 * value, enforced by the database function itself via COALESCE).
 */
export async function activateOrganizationBilling(organizationId: number): Promise<ReconcileOutcome> {
  const admin = createAdminClient();

  // R9-02: activation registers its OWN obligation. While one counter was
  // shared with subscription refresh, either kind of work could mark the
  // other kind's pending requests complete -- an activation write would
  // silently discharge a pending refresh it had never looked at.
  const { error: requestError } = await admin.rpc("request_billing_activation", {
    p_organization_id: organizationId,
  });
  if (requestError) {
    return { outcome: "error", message: `Failed to request activation: ${requestError.message}` };
  }

  const { data: claim, error: claimError } = await admin.rpc("claim_reconciliation_lease", {
    p_organization_id: organizationId,
  });
  if (claimError) {
    return { outcome: "error", message: `Failed to claim reconciliation lease: ${claimError.message}` };
  }
  const lease = claim?.[0];
  if (!lease) {
    return { outcome: "deferred" };
  }
  const owner = lease.owner_token;
  const generation = lease.requested_generation;
  const activationGeneration = lease.activation_generation;

  // Mirrors reconcileOrganizationBilling's own try/catch: an uncaught
  // exception here (a network-level throw from admin.rpc, not merely an
  // { error } result) would otherwise abandon the claimed lease with
  // needs_reconciliation never set -- release_reconciliation_lease's own
  // second UPDATE marks the organization dirty unconditionally, regardless
  // of whether the owner-matched release itself succeeds, which is exactly
  // the durable-recovery guarantee this function must not silently forfeit
  // just because it never reaches write_activation.
  try {
    const { data: applied, error: writeError } = await admin.rpc("write_activation", {
      p_organization_id: organizationId,
      p_owner: owner,
      p_requested_generation: generation,
      p_activation_generation: activationGeneration,
    });
    if (writeError) {
      return { outcome: "error", message: `Failed to write activation: ${writeError.message}` };
    }
    if (!applied) {
      return { outcome: "deferred" };
    }
    return { outcome: "reconciled", subscriptionId: "", status: "active" };
  } catch (err) {
    try {
      await admin.rpc("release_reconciliation_lease", { p_organization_id: organizationId, p_owner: owner });
    } catch {
      // Best-effort cleanup only -- the lease's own expiry is the fallback.
    }
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finding 11: validates that a subscription/invoice genuinely belongs to
 * the organization it's about to be applied to -- the Stripe Customer on
 * the object must match the organization's own already-persisted
 * customer id. A null persisted customer id is NOT treated as "nothing to
 * check" -- see callers for how that specific case is handled (it means
 * this is plausibly the organization's first-ever subscription, which
 * still requires the metadata-based resolution that got us to this
 * organization in the first place to be trustworthy, not a silent bind).
 */
export function customerIdMatches(persistedCustomerId: string | null, observedCustomerId: string): boolean {
  return persistedCustomerId === null || persistedCustomerId === observedCustomerId;
}
