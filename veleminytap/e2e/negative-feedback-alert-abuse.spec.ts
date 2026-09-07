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
  // something to attempt resetting. Round-3 R3-06: claim_negative_alert_send
  // now returns the new log row's id (a reservation), not a plain boolean.
  const claimed = await admin.rpc("claim_negative_alert_send", { p_nfc_card_id: card.cardId });
  expect(claimed.data).not.toBeNull();

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
  expect(first.data).not.toBeNull();
  expect(second.error).toBeNull();
  expect(second.data).toBeNull();
});

test("R3-02: an organization-wide budget of one under REAL concurrent claims for different cards lets exactly one through", async () => {
  const admin = adminClient();
  const BUDGET = 1;

  // Five distinct, never-claimed cards -- if the budget check and the
  // claim weren't serialized per organization, several of these could all
  // read "0 used, budget 1" before any of them committed. Promise.all
  // sends these as genuinely concurrent HTTP requests -- PostgREST opens
  // an independent connection/transaction per request, so this is real
  // concurrency, not a sequential loop dressed up to look like one (the
  // gap round-3 finding R3-02 explicitly called out as insufficient in an
  // earlier version of this suite).
  const cards: SeededCard[] = [];
  for (let i = 0; i < 5; i++) {
    cards.push(await seedActiveCard(member.orgId, `alert-budget-race-${i}`));
  }

  const results = await Promise.all(
    cards.map((c) =>
      admin.rpc("claim_negative_alert_send", {
        p_nfc_card_id: c.cardId,
        p_org_hourly_budget: BUDGET,
      }),
    ),
  );

  for (const r of results) {
    expect(r.error).toBeNull();
  }
  const claimedIds = results.map((r) => r.data).filter((id): id is number => id !== null);
  expect(claimedIds).toHaveLength(BUDGET);
  // And exactly one reservation exists to back that one claim -- distinct
  // log ids, not the same row counted twice.
  expect(new Set(claimedIds).size).toBe(BUDGET);
});

/**
 * Round-7 finding R7-05 (MEDIUM). claim_negative_alert_send() used now()
 * (frozen at this transaction's own START) for its cooldown check, budget
 * cutoff, and the timestamp it writes -- all evaluated AFTER acquiring a
 * per-organization advisory lock. Under genuine concurrency, a transaction
 * queued behind another can resume with real wall-clock time well past its
 * own frozen now(), so its checks (and the value it writes) reflect a
 * stale instant rather than the moment it actually runs. This is the same
 * class of bug round-6 R6-04 fixed in reserve_notification_email_change
 * (renamed from request_notification_email_change during a second
 * independent review -- see that migration's header comment) --
 * confirmed there as a real, reproducible, intermittent test failure
 * before the fix (see that migration's own comment) -- so this test uses
 * the identical shape: concurrent claims for the SAME card with
 * p_cooldown_minutes: 0 (meaning "no cooldown restriction at all") must
 * ALL succeed. Before the clock_timestamp() fix, the queued claim(s) could
 * spuriously see the card as still "on cooldown" and be incorrectly
 * rejected, purely from timing, not from the cooldown actually being in
 * effect.
 */
test("R7-05: concurrent claims for the SAME card with a zero-minute cooldown all succeed -- no spurious rejection from a frozen now()", async () => {
  const admin = adminClient();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      admin.rpc("claim_negative_alert_send", {
        p_nfc_card_id: card.cardId,
        p_cooldown_minutes: 0,
        p_org_hourly_budget: 100,
      }),
    ),
  );

  for (const r of results) {
    expect(r.error).toBeNull();
  }
  // Every one of the 5 concurrent claims must have succeeded (non-null) --
  // a zero-minute cooldown means there is no cooldown restriction to
  // reject any of them for, regardless of the order they actually run in
  // once serialized through the advisory lock.
  const claimedIds = results.map((r) => r.data).filter((id): id is number => id !== null);
  expect(claimedIds).toHaveLength(5);
  // Five genuinely distinct reservations, not the same one counted twice.
  expect(new Set(claimedIds).size).toBe(5);
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
