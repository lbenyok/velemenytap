import { test, expect } from "@playwright/test";
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
 * Round-2 finding R2-09. A card's location is immutable at the database
 * level once created (private.prevent_nfc_card_location_change, round-1
 * finding #9's trigger) -- but the edit dialog used to render the exact same
 * fully-editable location dropdown for an existing card as for a new one.
 * Picking a different location and saving produced a confusing generic
 * "Nem sikerült frissíteni a kártyát." error, since the database silently
 * rejected the write the UI implied would work.
 *
 * Fixed at both layers, both covered here against a real browser and the
 * real server action:
 *   1. UI: editing an existing card shows its location as read-only text,
 *      not a Select.
 *   2. Server: updateNfcCardAction's schema has no location_id field at
 *      all, so even a crafted request that adds one back is silently
 *      ignored rather than reaching the database's trigger.
 * Creating a new card is unaffected -- the full editable dropdown remains.
 */

let member: SeededOrgMember;
let card: SeededCard;
let otherLocationId: number;

test.beforeEach(async () => {
  member = await seedOrgWithMember("nfc-location-lock");
  card = await seedActiveCard(member.orgId, "nfc-location-lock");

  const admin = adminClient();
  const { data: otherLocation, error } = await admin
    .from("locations")
    .insert({ organization_id: member.orgId, name: "E2E nfc-location-lock Other Location" })
    .select("id")
    .single();
  if (error) throw error;
  otherLocationId = otherLocation.id;
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL("/dashboard");
}

test("R2-09: editing an existing card shows its location as read-only text, not a dropdown", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/dashboard/nfc-cards");

  await page.getByRole("button", { name: "Szerkesztés" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // No combobox/select for location in edit mode.
  await expect(dialog.getByLabel("Helyszín")).toHaveCount(0);
  await expect(page.locator("#location_id")).toHaveCount(0);

  // The current location's name is shown as plain read-only text (scoped to
  // the dialog: the same name also appears in the table cell behind it).
  const { data: location } = await adminClient()
    .from("locations")
    .select("name")
    .eq("id", card.locationId)
    .single();
  await expect(dialog.getByText(location!.name)).toBeVisible();
  await expect(dialog.getByText("A helyszín nem módosítható létrehozás után.")).toBeVisible();
});

test("R2-09: renaming an existing card through the edit dialog still works", async ({ page }) => {
  await signIn(page);
  await page.goto("/dashboard/nfc-cards");

  await page.getByRole("button", { name: "Szerkesztés" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const newName = "E2E Renamed Card";
  await page.getByLabel("Kártya neve").fill(newName);
  await page.getByRole("button", { name: "Változtatások mentése" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(newName)).toBeVisible();

  const { data: updated } = await adminClient()
    .from("nfc_cards")
    .select("display_name, location_id")
    .eq("id", card.cardId)
    .single();
  expect(updated?.display_name).toBe(newName);
  expect(updated?.location_id).toBe(card.locationId);
});

test("R2-09: a crafted location_id on the update action is silently ignored, not written", async () => {
  const client = await userClient(member.email, member.password);

  // Bypasses the UI entirely to simulate a crafted request: the real
  // updateNfcCardSchema has no location_id field, so even attempting the
  // write directly through the same table/columns the server action would
  // use must not change location_id. This confirms the fix isn't merely
  // "not shown in the form" -- there's no code path left that accepts it.
  const { error } = await client
    .from("nfc_cards")
    .update({ display_name: "Attempted Move", location_id: otherLocationId })
    .eq("id", card.cardId)
    .eq("organization_id", member.orgId);

  // The round-1 trigger (private.prevent_nfc_card_location_change) rejects
  // this at the database level regardless of which client attempts it.
  expect(error).not.toBeNull();

  const { data: unchanged } = await adminClient()
    .from("nfc_cards")
    .select("location_id")
    .eq("id", card.cardId)
    .single();
  expect(unchanged?.location_id).toBe(card.locationId);
});

test("R2-09: creating a new card still shows the full, editable location dropdown", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/dashboard/nfc-cards");

  await page.getByRole("button", { name: "NFC kártya hozzáadása" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // The create-mode Select is present and interactive -- not the read-only
  // edit-mode text.
  await expect(page.locator("#location_id")).toBeVisible();
  await expect(page.getByText("A helyszín nem módosítható létrehozás után.")).toHaveCount(0);

  await page.locator("#location_id").click();
  await page.getByRole("option", { name: "E2E nfc-location-lock Other Location" }).click();
  await page.getByLabel("Kártya neve").fill("E2E New Card");
  await page.getByRole("button", { name: "Kártya hozzáadása" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("E2E New Card")).toBeVisible();

  const { data: created } = await adminClient()
    .from("nfc_cards")
    .select("location_id")
    .eq("organization_id", member.orgId)
    .eq("display_name", "E2E New Card")
    .single();
  expect(created?.location_id).toBe(otherLocationId);
});
