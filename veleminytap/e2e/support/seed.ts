import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./env";

loadEnv();

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SECRET_KEY are required to run e2e tests -- see e2e/README.md.",
    );
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export type SeededOrg = {
  orgId: number;
  cards: { rating: number; publicId: string }[];
};

/**
 * Creates one throwaway org/location, one NFC card per rating 1-5 (so each
 * rating's test hits a fresh card and can never collide with another
 * rating's duplicate-submission cookie), and a real Google Review URL --
 * required for the review-gating assertion to mean anything (the CTA is
 * conditionally rendered on googleReviewUrl being set at all).
 *
 * Runs against the same Supabase project used for local dev/production --
 * see DECISIONS.md for why, and note the org name prefix used for cleanup.
 */
export async function seedReviewGatingOrg(): Promise<SeededOrg> {
  const admin = adminClient();
  const orgName = `E2E Review Gating ${Date.now()}`;

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({ name: orgName, slug: `e2e-review-gating-${Date.now()}` })
    .select("id")
    .single();
  if (orgError) throw orgError;

  const { data: location, error: locationError } = await admin
    .from("locations")
    .insert({
      organization_id: org.id,
      name: "E2E Test Location",
      google_review_url: "https://g.page/r/e2e-test-review-link",
    })
    .select("id")
    .single();
  if (locationError) throw locationError;

  const cards: { rating: number; publicId: string }[] = [];
  for (const rating of [1, 2, 3, 4, 5]) {
    const { data: card, error: cardError } = await admin
      .from("nfc_cards")
      .insert({
        organization_id: org.id,
        location_id: location.id,
        display_name: `E2E Card (rating ${rating})`,
      })
      .select("public_id")
      .single();
    if (cardError) throw cardError;
    cards.push({ rating, publicId: card.public_id });
  }

  return { orgId: org.id, cards };
}

/** Deletes everything the seed created, in FK-safe order. */
export async function cleanupOrg(orgId: number): Promise<void> {
  const admin = adminClient();
  await admin.from("feedback").delete().eq("organization_id", orgId);
  await admin.from("nfc_cards").delete().eq("organization_id", orgId);
  await admin.from("locations").delete().eq("organization_id", orgId);
  await admin.from("organization_memberships").delete().eq("organization_id", orgId);
  await admin.from("organizations").delete().eq("id", orgId);
}

export type SeededAuthUser = { userId: string; email: string; password: string; orgId: number };

/**
 * Creates a throwaway, pre-confirmed auth user for driving the real login
 * form -- plus an organization/membership for it, since the dashboard
 * layout redirects any org-less authenticated user to /onboarding. Without
 * this, a redirect test would always land on /onboarding no matter what its
 * safe fallback target was, masking the actual thing under test.
 */
export async function seedAuthUser(): Promise<SeededAuthUser> {
  const admin = adminClient();
  const email = `e2e-redirect-safety-${Date.now()}@example.com`;
  const password = `E2e-Test-${Date.now()}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({ name: `E2E Redirect Safety ${Date.now()}`, slug: `e2e-redirect-safety-${Date.now()}` })
    .select("id")
    .single();
  if (orgError) throw orgError;

  const { error: membershipError } = await admin
    .from("organization_memberships")
    .insert({ organization_id: org.id, user_id: userData.user.id, role: "owner" });
  if (membershipError) throw membershipError;

  return { userId: userData.user.id, email, password, orgId: org.id };
}

export async function cleanupAuthUser(userId: string, orgId: number): Promise<void> {
  const admin = adminClient();
  await admin.from("organization_memberships").delete().eq("organization_id", orgId);
  await admin.from("organizations").delete().eq("id", orgId);
  await admin.auth.admin.deleteUser(userId);
}

/**
 * Generates a real, single-use email-OTP token_hash for an existing user --
 * the same mechanism a magic-link/confirmation email would carry -- so a
 * test can hit /auth/confirm and exercise its success branch (including the
 * `next` redirect) without actually sending or reading an email.
 */
export async function generateConfirmToken(email: string): Promise<{ tokenHash: string }> {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  return { tokenHash: data.properties.hashed_token };
}
