import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadEnv } from "./env";

loadEnv();

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SECRET_KEY are required to run e2e tests -- see e2e/README.md.",
    );
  }
  return createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * "JWT issued at future" (PostgREST error PGRST303) has been observed
 * intermittently against this isolated test project -- never reproducibly,
 * and unrelated to anything under test (it's a clock-skew condition inside
 * Supabase's own infra for a freshly created project, not this app's code).
 * Retries a PostgREST call up to twice more after a short pause, same
 * mitigation as userClient()'s post-sign-in probe.
 */
export async function retryOnClockSkew<T extends { error: { code?: string } | null }>(
  fn: () => PromiseLike<T>,
): Promise<T> {
  let result = await fn();
  for (let attempt = 0; attempt < 2 && result.error?.code === "PGRST303"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await fn();
  }
  return result;
}

export type SeededFeedbackFixture = {
  locationId: number;
  otherLocationId: number;
  cardId: number;
  feedbackId: number;
};

/**
 * One location, a second "other" location in the same org (for relocation
 * tests), one NFC card at the first location, and one feedback row on that
 * card -- the fixture RLS/consistency tests build their assertions on top
 * of. Uses the admin client (bypasses RLS) since seeding test data is not
 * itself part of what's under test.
 */
export async function seedFeedbackFixture(orgId: number, namePrefix: string): Promise<SeededFeedbackFixture> {
  const admin = adminClient();

  const { data: location, error: locationError } = await admin
    .from("locations")
    .insert({ organization_id: orgId, name: `E2E ${namePrefix} Location A` })
    .select("id")
    .single();
  if (locationError) throw locationError;

  const { data: otherLocation, error: otherLocationError } = await admin
    .from("locations")
    .insert({ organization_id: orgId, name: `E2E ${namePrefix} Location B` })
    .select("id")
    .single();
  if (otherLocationError) throw otherLocationError;

  const { data: card, error: cardError } = await admin
    .from("nfc_cards")
    .insert({ organization_id: orgId, location_id: location.id, display_name: "E2E Card" })
    .select("id")
    .single();
  if (cardError) throw cardError;

  const { data: feedback, error: feedbackError } = await admin
    .from("feedback")
    .insert({
      organization_id: orgId,
      location_id: location.id,
      nfc_card_id: card.id,
      rating: 3,
      feedback_text: "Original feedback text",
    })
    .select("id")
    .single();
  if (feedbackError) throw feedbackError;

  return {
    locationId: location.id,
    otherLocationId: otherLocation.id,
    cardId: card.id,
    feedbackId: feedback.id,
  };
}

export type SeededCard = { cardId: number; publicId: string; locationId: number };

/** One location and one active NFC card with no feedback on it yet. */
export async function seedActiveCard(orgId: number, namePrefix: string): Promise<SeededCard> {
  const admin = adminClient();

  const { data: location, error: locationError } = await admin
    .from("locations")
    .insert({ organization_id: orgId, name: `E2E ${namePrefix} Location` })
    .select("id")
    .single();
  if (locationError) throw locationError;

  const { data: card, error: cardError } = await admin
    .from("nfc_cards")
    .insert({ organization_id: orgId, location_id: location.id, display_name: "E2E Card" })
    .select("id, public_id")
    .single();
  if (cardError) throw cardError;

  return { cardId: card.id, publicId: card.public_id, locationId: location.id };
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

export type SeededPlainUser = { userId: string; email: string; password: string };

/** A throwaway, pre-confirmed auth user with NO organization -- for onboarding tests. */
export async function seedPlainUser(namePrefix: string): Promise<SeededPlainUser> {
  const admin = adminClient();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${namePrefix}-${unique}@example.com`;
  const password = `E2e-Test-${unique}!`;

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  return { userId: data.user.id, email, password };
}

export async function cleanupPlainUser(userId: string): Promise<void> {
  const admin = adminClient();
  const { data: memberships } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId);
  for (const m of memberships ?? []) {
    await admin.from("feedback").delete().eq("organization_id", m.organization_id);
    await admin.from("nfc_cards").delete().eq("organization_id", m.organization_id);
    await admin.from("locations").delete().eq("organization_id", m.organization_id);
    await admin.from("organization_memberships").delete().eq("organization_id", m.organization_id);
    await admin.from("organizations").delete().eq("id", m.organization_id);
  }
  await admin.auth.admin.deleteUser(userId);
}

export type SeededOrgMember = {
  userId: string;
  email: string;
  password: string;
  orgId: number;
};

/**
 * Creates a throwaway, pre-confirmed auth user plus an organization/
 * membership for it -- the building block every RLS-as-a-real-user test and
 * the redirect-safety suite need. (The dashboard layout redirects any
 * org-less authenticated user to /onboarding, so without a membership,
 * *any* post-login redirect test would land there regardless of its actual
 * target, masking the thing under test.)
 */
export async function seedOrgWithMember(
  namePrefix: string,
  role: "owner" | "admin" | "manager" | "staff" = "owner",
): Promise<SeededOrgMember> {
  const admin = adminClient();
  // Date.now() alone collides under parallel workers (millisecond
  // resolution, multiple workers starting within the same tick) -- unique
  // per call regardless of timing.
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${namePrefix}-${unique}@example.com`;
  const password = `E2e-Test-${unique}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;

  // If anything below fails, delete the just-created user rather than
  // leaving it orphaned -- afterEach never runs for a beforeEach that threw,
  // so without this a flaky run (or a real bug this fixture happens to
  // trip) accumulates leftover auth users in the test project.
  try {
    const { data: org, error: orgError } = await retryOnClockSkew(() =>
      admin
        .from("organizations")
        .insert({ name: `E2E ${namePrefix} ${unique}`, slug: `e2e-${namePrefix}-${unique}` })
        .select("id")
        .single(),
    );
    if (orgError) throw orgError;

    const { error: membershipError } = await retryOnClockSkew(() =>
      admin
        .from("organization_memberships")
        .insert({ organization_id: org.id, user_id: userData.user.id, role }),
    );
    if (membershipError) throw membershipError;

    return { userId: userData.user.id, email, password, orgId: org.id };
  } catch (err) {
    await admin.auth.admin.deleteUser(userData.user.id);
    throw err;
  }
}

export async function cleanupOrgWithMember(userId: string, orgId: number): Promise<void> {
  const admin = adminClient();
  await admin.from("feedback").delete().eq("organization_id", orgId);
  await admin.from("nfc_cards").delete().eq("organization_id", orgId);
  await admin.from("locations").delete().eq("organization_id", orgId);
  await admin.from("organization_memberships").delete().eq("organization_id", orgId);
  await admin.from("organizations").delete().eq("id", orgId);
  await admin.auth.admin.deleteUser(userId);
}

/**
 * A signed-in, RLS-bound client for a seeded user -- the publishable key,
 * not the secret key, so every query goes through the exact same RLS
 * policies the real dashboard runs under. This is how RLS itself gets
 * tested directly (not just through the app's own query shapes, which
 * might never happen to exercise a gap the policy leaves open).
 */
export async function userClient(email: string, password: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required -- see e2e/README.md.",
    );
  }
  const client = createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;

  // A freshly minted JWT's `iat` can transiently fail PostgREST's clock-skew
  // check ("JWT issued at future", PGRST303) on this project -- seen
  // intermittently, never reproducibly, and unrelated to anything under
  // test here. One retry after a short pause clears it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await client.from("organizations").select("id").limit(1);
    if (!probe.error || probe.error.code !== "PGRST303") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return client;
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
