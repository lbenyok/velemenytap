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
 * Covers review findings #6 (atomic active-status check) and #2 (public
 * submission abuse / email-amplification), all against submit_feedback_atomic
 * directly or through the real public form.
 */

let org: SeededOrgMember;
let card: SeededCard;

test.beforeEach(async () => {
  org = await seedOrgWithMember("submission-safety");
  card = await seedActiveCard(org.orgId, "submission-safety");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(org.userId, org.orgId);
});

test("finding #6: deactivating a card between page load and submission is caught atomically, not just at page load", async ({
  page,
}) => {
  await page.goto(`/r/${card.publicId}`);
  await page.getByRole("radio", { name: /^4 csillag —/ }).click();

  // Deactivate the card server-side, simulating a manager clicking
  // "deactivate" in the dashboard in the window between page load and this
  // browser submitting -- the exact race the old lookup-then-insert had.
  const admin = adminClient();
  const { error: deactivateError } = await admin
    .from("nfc_cards")
    .update({ status: "inactive" })
    .eq("id", card.cardId);
  expect(deactivateError).toBeNull();

  await page.getByRole("button", { name: "Vélemény küldése" }).click();

  // Not getByRole("alert") -- that also matches Next's own route-announcer
  // div (role="alert", always present, empty text), which makes a strict
  // locator ambiguous. The submission error is specifically a <p
  // role="alert">.
  await expect(page.locator('p[role="alert"]')).toHaveText("Ez a link már nem aktív.");

  const { data: rows } = await admin.from("feedback").select("id").eq("nfc_card_id", card.cardId);
  expect(rows).toHaveLength(0);
});

test("finding #2: more than the per-card rate limit within the window is rejected", async ({
  page,
}) => {
  const admin = adminClient();

  // Prime the count to the limit directly (fast) rather than through 20
  // real form submissions -- the RPC is exactly what's under test either
  // way, this just avoids 20 browser round trips.
  for (let i = 0; i < 20; i++) {
    const { error } = await admin.rpc("submit_feedback_atomic", {
      p_public_id: card.publicId,
      p_rating: 5,
      p_feedback_text: null,
    });
    expect(error).toBeNull();
  }

  // The 21st, through the real public form, must show the rate-limit
  // message -- not "card inactive" and not a generic failure.
  await page.goto(`/r/${card.publicId}`);
  await page.getByRole("radio", { name: /^5 csillag —/ }).click();
  await page.getByRole("button", { name: "Vélemény küldése" }).click();

  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Túl sok vélemény érkezett erről a kártyáról. Kérjük, próbáld újra pár perc múlva.",
  );

  const { count } = await admin
    .from("feedback")
    .select("id", { count: "exact", head: true })
    .eq("nfc_card_id", card.cardId);
  expect(count).toBe(20);
});

test("finding #2: the negative-feedback alert cooldown claim lets only one claim through per window", async () => {
  // Exercises the exact atomic UPDATE ... WHERE ... RETURNING pattern
  // negative-feedback-alert.ts uses, without needing a configured Resend
  // key (this test project deliberately has none -- see e2e/README.md) or
  // sending a real email. Postgres's row-level locking is what makes two
  // concurrent claims for the same card resolve to exactly one winner; this
  // confirms the query shape actually has that effect.
  const admin = adminClient();
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

  const first = await admin
    .from("nfc_cards")
    .update({ last_negative_alert_at: new Date().toISOString() })
    .eq("id", card.cardId)
    .or(`last_negative_alert_at.is.null,last_negative_alert_at.lt.${cutoff}`)
    .select("id")
    .maybeSingle();
  expect(first.data).not.toBeNull();

  const second = await admin
    .from("nfc_cards")
    .update({ last_negative_alert_at: new Date().toISOString() })
    .eq("id", card.cardId)
    .or(`last_negative_alert_at.is.null,last_negative_alert_at.lt.${cutoff}`)
    .select("id")
    .maybeSingle();
  expect(second.data).toBeNull();
});
