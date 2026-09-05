"use server";

import { redirect } from "next/navigation";
import { createStripeClient } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrganization } from "@/features/organizations/current";

/**
 * Finds this organization's Stripe customer, creating one on first use.
 * Uses the admin client -- organization_billing has no UPDATE policy for
 * `authenticated` (see the billing migration), by design: an owner must
 * never be able to grant their own organization an active subscription
 * by writing to this table directly.
 */
async function getOrCreateStripeCustomerId(
  organizationId: number,
  organizationName: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data: billing } = await admin
    .from("organization_billing")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .single();

  if (billing?.stripe_customer_id) {
    return billing.stripe_customer_id;
  }

  const stripe = createStripeClient();
  const customer = await stripe.customers.create({
    name: organizationName,
    metadata: { organization_id: organizationId.toString() },
  });

  await admin
    .from("organization_billing")
    .update({ stripe_customer_id: customer.id })
    .eq("organization_id", organizationId);

  return customer.id;
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
export async function createCheckoutSessionAction(): Promise<void> {
  const organization = await getCurrentOrganization();
  if (!organization) {
    redirect("/onboarding");
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!;
  let target: string;

  try {
    const customerId = await getOrCreateStripeCustomerId(organization.id, organization.name);
    const stripe = createStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: organization.id.toString(),
      line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
      success_url: `${siteUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
      metadata: { organization_id: organization.id.toString() },
      // Carried forward onto the Subscription object itself, not just this
      // Checkout Session -- the webhook handler reads it from every
      // subsequent subscription event (including ones from the customer
      // portal, which never goes through this action again).
      subscription_data: { metadata: { organization_id: organization.id.toString() } },
    });

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL");
    }
    target = session.url;
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
    const { data: billing } = await admin
      .from("organization_billing")
      .select("stripe_customer_id")
      .eq("organization_id", organization.id)
      .single();

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
