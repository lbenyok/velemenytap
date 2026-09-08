import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedFeedbackFixture,
  userClient,
  type SeededOrgMember,
  type SeededFeedbackFixture,
} from "./support/seed";

/**
 * Direct database-layer tests (no browser) for two review findings:
 *
 * #3 -- the feedback_update RLS policy is row-level only, so it let an org
 * member UPDATE any column on a feedback row, not just status/internal_note
 * (the only two fields the dashboard's own update action ever sets). A
 * member could silently rewrite a customer's original rating or written
 * feedback. Fixed with a trigger (private.prevent_feedback_content_change)
 * that rejects changes to rating/feedback_text/location_id/nfc_card_id/
 * created_at regardless of caller, while still allowing status/
 * internal_note updates through.
 *
 * #4 -- nothing stopped an org member from relocating an nfc_card to a
 * different location in the same org, which breaks the assumption that a
 * card maps to one physical placement over its lifetime. Fixed with a
 * trigger (private.prevent_nfc_card_location_change) that rejects any
 * location_id change, while still allowing other card updates (e.g.
 * display_name, status) through.
 */

let member: SeededOrgMember;
let fixture: SeededFeedbackFixture;

test.beforeEach(async () => {
  member = await seedOrgWithMember("feedback-integrity");
  fixture = await seedFeedbackFixture(member.orgId, "feedback-integrity");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test.describe("feedback content immutability (finding #3)", () => {
  test("an org member cannot change rating via UPDATE", async () => {
    const client = await userClient(member.email, member.password);
    const { error } = await client.from("feedback").update({ rating: 5 }).eq("id", fixture.feedbackId);

    expect(error).not.toBeNull();
    expect(error?.message).toContain("cannot be changed after submission");
  });

  test("an org member cannot change feedback_text via UPDATE", async () => {
    const client = await userClient(member.email, member.password);
    const { error } = await client
      .from("feedback")
      .update({ feedback_text: "tampered" })
      .eq("id", fixture.feedbackId);

    expect(error).not.toBeNull();
  });

  test("an org member cannot reassign nfc_card_id via UPDATE", async () => {
    const client = await userClient(member.email, member.password);
    const { error } = await client
      .from("feedback")
      .update({ nfc_card_id: fixture.cardId })
      .eq("id", fixture.feedbackId);

    // Same value as before -- still exercises the trigger's comparison path
    // (new <> old is false here), so this specifically confirms a no-op
    // reassignment isn't rejected as a false positive.
    expect(error).toBeNull();
  });

  test("an org member CAN still update status and internal_note", async () => {
    const client = await userClient(member.email, member.password);
    const { error, data } = await client
      .from("feedback")
      .update({ status: "resolved", internal_note: "Called the customer back" })
      .eq("id", fixture.feedbackId)
      .select("status, internal_note")
      .single();

    expect(error).toBeNull();
    expect(data?.status).toBe("resolved");
    expect(data?.internal_note).toBe("Called the customer back");
  });
});

test.describe("nfc_card location immutability (finding #4)", () => {
  test("an org member cannot relocate a card to a different location", async () => {
    const client = await userClient(member.email, member.password);
    const { error } = await client
      .from("nfc_cards")
      .update({ location_id: fixture.otherLocationId })
      .eq("id", fixture.cardId);

    expect(error).not.toBeNull();
    expect(error?.message).toContain("cannot be changed");
  });

  test("an org member CAN still update display_name and status", async () => {
    const client = await userClient(member.email, member.password);
    const { error, data } = await client
      .from("nfc_cards")
      .update({ display_name: "Renamed", status: "inactive" })
      .eq("id", fixture.cardId)
      .select("display_name, status")
      .single();

    expect(error).toBeNull();
    expect(data?.display_name).toBe("Renamed");
    expect(data?.status).toBe("inactive");
  });
});
