"use server";

import { redirect } from "next/navigation";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";
import { getOrganizationBilling } from "@/features/billing/queries";
import { isBillingInterval, stripePriceId } from "@/features/billing/plans";

// Collapses a double form-submit (a double-click before the button
// disables, or a browser/network-level automatic retry) into the same
// Stripe request instead of creating two Checkout Sessions for the same
// organization -- scoped to a short window, not the organization
// permanently, since Stripe only remembers an idempotency key for 24
// hours and a genuine later resubscribe attempt (e.g. after a prior
// Checkout was abandoned) must not be blocked by an earlier, unrelated
// one that happened to reuse the same key.
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 30_000;

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
  const customer = await stripe.customers.create({
    name: organizationName,
    metadata: { organization_id: organizationId.toString() },
  });

  // Concurrency guard: `.is("stripe_customer_id", null)` means this
  // UPDATE only actually applies if nothing else has already set it since
  // the read above -- a second, concurrent call (e.g. a double-submitted
  // form) racing this same function for the same organization will lose
  // this UPDATE (it matches zero rows) rather than overwriting the
  // winner's id with its own, orphaning whichever Stripe customer object
  // doesn't end up persisted.
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
 */
export async function createCheckoutSessionAction(formData: FormData): Promise<void> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const interval = formData.get("interval");
  if (!isBillingInterval(interval)) {
    redirect("/dashboard/billing?error=checkout_failed");
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!;
  let target: string;

  try {
    const billing = await getOrganizationBilling(organization.id);
    if (billing?.stripe_subscription_id) {
      // The billing page itself only ever renders the Checkout forms when
      // there's no stripe_subscription_id yet (see app/dashboard/billing/
      // page.tsx's `hasSubscription`) -- this is the server-side half of
      // that same rule, for a request that reaches this action anyway
      // (stale page state, a replayed submission, or a direct POST) not
      // otherwise reflected in a client render. Creating a second
      // subscription for an organization that already has one would
      // double-charge it.
      target = "/dashboard/billing?error=already_subscribed";
    } else {
      const customerId = await getOrCreateStripeCustomerId(organization.id, organization.name);
      const stripe = createStripeClient();
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: customerId,
          client_reference_id: organization.id.toString(),
          line_items: [{ price: stripePriceId(interval), quantity: 1 }],
          success_url: `${siteUrl}/dashboard/billing?checkout=success`,
          cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
          metadata: { organization_id: organization.id.toString() },
          // Carried forward onto the Subscription object itself, not just
          // this Checkout Session -- the webhook handler reads it from
          // every subsequent subscription event (including ones from the
          // customer portal, which never goes through this action again).
          subscription_data: { metadata: { organization_id: organization.id.toString() } },
        },
        {
          idempotencyKey: `checkout:${organization.id}:${interval}:${Math.floor(Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS)}`,
        },
      );

      if (!session.url) {
        throw new Error("Stripe did not return a Checkout URL");
      }
      target = session.url;
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
 * why redirect() is only ever called once, outside the try/catch.
 */
export async function createPortalSessionAction(): Promise<void> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
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
