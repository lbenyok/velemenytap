import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  userClient,
  type SeededOrgMember,
  type SeededCard,
} from "./support/seed";

/**
 * Round-2 finding R2-08. The round-1 alert cooldown (finding #2) was a
 * plain column (nfc_cards.last_negative_alert_at) updated via a raw
 * UPDATE, guarded only by RLS's row-level nfc_cards_update policy -- RLS
 * is row-level, not column-level, so an org member's own authenticated
 * session could reset it directly (confirmed empirically before writing
 * this fix). Combined with an unverified notification_email and a
 * per-card rate limit that doesn't bound total volume across an org's
 * cards, this was a real spam-relay vector.
 *
 * Fixed with two independent, atomic, server-owned controls, both
 * verified here without sending a single real email (this test project
 * deliberately has no RESEND_API_KEY -- see e2e/README.md):
 *   1. last_negative_alert_at can only be changed by
 *      claim_negative_alert_send() -- a trigger rejects any other UPDATE
 *      to it, from any caller, including the admin client itself.
 *   2. An organization-wide hourly budget, independent of which card(s)
 *      qualifying submissions come from.
 */

let member: SeededOrgMember;
let card: SeededCard;

test.beforeEach(async () => {
  member = await seedOrgWithMember("alert-abuse");
  card = await seedActiveCard(member.orgId, "alert-abuse");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("R2-08: a tenant's own authenticated session cannot reset the alert cooldown via a direct UPDATE", async () => {
  const admin = adminClient();
  // Prime a claimed cooldown first, via the legitimate path, so there's
  // something to attempt resetting.
  const claimed = await admin.rpc("claim_negative_alert_send", { p_nfc_card_id: card.cardId });
  expect(claimed.data).toBe(true);

  const client = await userClient(member.email, member.password);
  const { data, error } = await client
    .from("nfc_cards")
    .update({ last_negative_alert_at: null })
    .eq("id", card.cardId)
    .select("last_negative_alert_at");

  expect(error).not.toBeNull();
  expect(error?.message).toContain("claim_negative_alert_send");
  expect(data).toBeNull();

  const { data: unchanged } = await admin
    .from("nfc_cards")
    .select("last_negative_alert_at")
    .eq("id", card.cardId)
    .single();
  expect(unchanged?.last_negative_alert_at).not.toBeNull();
});

test("R2-08: anon and authenticated cannot call claim_negative_alert_send directly", async () => {
  const anonClient = userClientAnon();
  const { error: anonError } = await anonClient.rpc("claim_negative_alert_send", {
    p_nfc_card_id: card.cardId,
  });
  expect(anonError?.message).toContain("permission denied for function");

  const client = await userClient(member.email, member.password);
  const { error: authError } = await client.rpc("claim_negative_alert_send", {
    p_nfc_card_id: card.cardId,
  });
  expect(authError?.message).toContain("permission denied for function");
});

test("R2-08: claim_negative_alert_send lets only one claim through per card per cooldown window", async () => {
  const admin = adminClient();
  const first = await admin.rpc("claim_negative_alert_send", { p_nfc_card_id: card.cardId });
  const second = await admin.rpc("claim_negative_alert_send", { p_nfc_card_id: card.cardId });

  expect(first.error).toBeNull();
  expect(first.data).toBe(true);
  expect(second.error).toBeNull();
  expect(second.data).toBe(false);
});

test("R2-08: an organization-wide hourly budget caps total claims regardless of how many different cards they come from", async () => {
  const admin = adminClient();
  const BUDGET = 5;

  // 6 distinct, never-claimed-before cards -- if only the per-card
  // cooldown applied (finding #2's original fix), every one of these would
  // succeed, since none has ever been claimed. Only an org-wide budget can
  // explain a rejection here.
  const cardIds: number[] = [card.cardId];
  for (let i = 0; i < BUDGET; i++) {
    const extra = await seedActiveCard(member.orgId, `alert-abuse-budget-${i}`);
    cardIds.push(extra.cardId);
  }

  const results: boolean[] = [];
  for (const cardId of cardIds) {
    const r = await admin.rpc("claim_negative_alert_send", {
      p_nfc_card_id: cardId,
      p_org_hourly_budget: BUDGET,
    });
    expect(r.error).toBeNull();
    results.push(Boolean(r.data));
  }

  const claimedCount = results.filter(Boolean).length;
  expect(claimedCount).toBe(BUDGET);
  expect(results[results.length - 1]).toBe(false);
});

function userClientAnon() {
  // A fresh, never-signed-in client -- genuinely anonymous, not just an
  // authenticated user acting oddly.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
