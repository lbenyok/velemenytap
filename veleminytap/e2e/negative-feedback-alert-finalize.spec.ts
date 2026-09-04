import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  type SeededOrgMember,
  type SeededCard,
} from "./support/seed";

/**
 * Round-3 finding R3-06. claim_negative_alert_send() used to insert a log
 * row as an unconditional record of an alert "actually sent" the moment
 * the cooldown/budget checks passed -- before the caller had even looked
 * up a recipient, let alone called Resend. A missing notification_email,
 * an org with no owner/admin/manager members, or a genuine Resend API
 * failure all consumed a slot in the org-wide budget for an email that
 * was never sent.
 *
 * Fixed: claim_negative_alert_send() now returns a *reservation* id, and
 * finalize_negative_alert_send(log_id, delivered) reports the real
 * outcome. These tests exercise both functions directly (the same "call
 * the RPC, observe budget behavior" style as negative-feedback-alert-abuse.spec.ts
 * -- private.alert_email_log itself isn't exposed to PostgREST, so its
 * effects are observed the same way every other test in this suite
 * observes them: through the RPCs' own return values).
 */

let member: SeededOrgMember;
let cardA: SeededCard;
let cardB: SeededCard;

test.beforeEach(async () => {
  member = await seedOrgWithMember("alert-finalize");
  cardA = await seedActiveCard(member.orgId, "alert-finalize-a");
  cardB = await seedActiveCard(member.orgId, "alert-finalize-b");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("R3-06: a reservation finalized as failed does not count against the org budget afterward", async () => {
  const admin = adminClient();
  const BUDGET = 1;

  const first = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardA.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(first.error).toBeNull();
  expect(first.data).not.toBeNull();

  const finalize = await admin.rpc("finalize_negative_alert_send", {
    p_log_id: first.data!,
    p_delivered: false,
  });
  expect(finalize.error).toBeNull();

  // A second card's claim, same org, same tiny budget -- must succeed,
  // because the first attempt is now known to have failed and no longer
  // counts. If it still counted, this would return null.
  const second = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardB.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(second.error).toBeNull();
  expect(second.data).not.toBeNull();
});

test("R3-06: a reservation finalized as delivered DOES count against the org budget afterward", async () => {
  const admin = adminClient();
  const BUDGET = 1;

  const first = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardA.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(first.data).not.toBeNull();

  const finalize = await admin.rpc("finalize_negative_alert_send", {
    p_log_id: first.data!,
    p_delivered: true,
  });
  expect(finalize.error).toBeNull();

  const second = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardB.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(second.error).toBeNull();
  expect(second.data).toBeNull();
});

test("R3-06: an unfinalized (in-flight) reservation still counts against the budget while unresolved", async () => {
  const admin = adminClient();
  const BUDGET = 1;

  const first = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardA.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(first.data).not.toBeNull();
  // Deliberately never finalized -- simulates a process that crashed
  // between claiming and reporting the outcome.

  const second = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardB.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(second.error).toBeNull();
  expect(second.data).toBeNull();
});

test("R3-06: finalize is idempotent -- a later call cannot flip an already-finalized reservation's outcome", async () => {
  const admin = adminClient();
  const BUDGET = 1;

  const first = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardA.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(first.data).not.toBeNull();

  const finalizeDelivered = await admin.rpc("finalize_negative_alert_send", {
    p_log_id: first.data!,
    p_delivered: true,
  });
  expect(finalizeDelivered.error).toBeNull();

  // A second, contradicting call -- e.g. a duplicate/retried finalize --
  // must be a silent no-op (`where status = 'reserved'` in the function
  // no longer matches once it's already 'delivered'), not a real
  // transition to 'failed'.
  const finalizeFailedAfter = await admin.rpc("finalize_negative_alert_send", {
    p_log_id: first.data!,
    p_delivered: false,
  });
  expect(finalizeFailedAfter.error).toBeNull();

  // If the second call had actually flipped it to 'failed', this would
  // succeed (null no longer expected); it must still be null, proving the
  // row is still counted as 'delivered'.
  const second = await admin.rpc("claim_negative_alert_send", {
    p_nfc_card_id: cardB.cardId,
    p_org_hourly_budget: BUDGET,
  });
  expect(second.error).toBeNull();
  expect(second.data).toBeNull();
});
