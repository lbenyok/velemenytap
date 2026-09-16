import { test, expect, type Page } from "@playwright/test"
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  type SeededOrgMember,
} from "./support/seed"

/**
 * The public rating flow where the destination or the card is not usable:
 * no Google URL, a stored-but-invalid one, and a card switched off.
 *
 * In every one of these the customer's rating is still handled honestly --
 * saved and confirmed where it can be, refused and said so where it cannot --
 * and the only thing that ever decides whether a Google link appears is
 * whether the location's stored URL passes `safeGoogleReviewUrl`.
 */

const SAVED = "Köszönjük, az értékelésedet elmentettük."
const COMMENT_LABEL = "Megjegyzés a vállalkozásnak (nem kötelező)"

let org: SeededOrgMember

test.beforeEach(async () => {
  org = await seedOrgWithMember("public-destinations")
})

test.afterEach(async () => {
  if (org) await cleanupOrgWithMember(org.userId, org.orgId)
})

const star = (page: Page, rating: number) =>
  page.getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })

async function rowsFor(cardId: number) {
  const { data, error } = await adminClient()
    .from("feedback")
    .select("rating, feedback_text")
    .eq("nfc_card_id", cardId)
  expect(error).toBeNull()
  return data ?? []
}

for (const rating of [1, 5] as const) {
  test(`no Google URL, rating ${rating}: saved, useful comment screen, no Google link`, async ({
    page,
  }) => {
    const card = await seedActiveCard(org.orgId, `no-url-${rating}`)

    await page.goto(`/r/${card.publicId}`)
    await star(page, rating).click()

    await expect(
      page.getByRole("status").filter({ hasText: SAVED })
    ).toBeVisible()
    await expect(page.getByLabel(COMMENT_LABEL)).toBeVisible()
    await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0)
    // The customer is not told about a configuration problem that is the
    // business's to fix; the dashboard flags it
    // (location-google-url-warning.spec.ts).
    await expect(page.getByText(/link|beállít/i)).toHaveCount(0)

    await page.getByLabel(COMMENT_LABEL).fill("Nincs Google-link, de ez eljut.")
    await page.getByRole("button", { name: "Megjegyzés küldése" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: "továbbítottuk" })
    ).toBeVisible()
    expect(await rowsFor(card.cardId)).toEqual([
      { rating, feedback_text: "Nincs Google-link, de ez eljut." },
    ])
  })
}

test("a stored-but-invalid Google URL is never linked, on the saved screen or an error screen", async ({
  page,
}) => {
  const card = await seedActiveCard(org.orgId, "bad-url")
  const bad = "https://example.com/not-google"
  const { error } = await adminClient()
    .from("locations")
    .update({ google_review_url: bad })
    .eq("id", card.locationId)
  expect(error).toBeNull()

  await page.goto(`/r/${card.publicId}`)
  // The raw value never even reaches the browser.
  expect(await page.content()).not.toContain("example.com/not-google")

  await star(page, 4).click()
  await expect(
    page.getByRole("status").filter({ hasText: SAVED })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0)
  await expect(page.locator(`a[href*="example.com"]`)).toHaveCount(0)

  // And on the duplicate screen, which offers Google when it can.
  await page.goto(`/r/${card.publicId}`)
  await star(page, 4).click()
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Ehhez a látogatáshoz már küldtél értékelést. Köszönjük!"
  )
  await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0)
})

test("the Google link comes from the card's own location, not another one in the same organization", async ({
  page,
}) => {
  const mine = await seedActiveCard(org.orgId, "own-location")
  const other = await seedActiveCard(org.orgId, "other-location")
  const admin = adminClient()
  await admin
    .from("locations")
    .update({ google_review_url: "https://g.page/r/e2e-own-location" })
    .eq("id", mine.locationId)
  await admin
    .from("locations")
    .update({ google_review_url: "https://g.page/r/e2e-other-location" })
    .eq("id", other.locationId)

  await page.goto(`/r/${mine.publicId}`)
  await star(page, 3).click()
  await expect(
    page.getByRole("link", { name: "Értékelés a Google-on" })
  ).toHaveAttribute("href", "https://g.page/r/e2e-own-location")
})

test("a card switched off before the page loads shows the inactive screen and no stars", async ({
  page,
}) => {
  const card = await seedActiveCard(org.orgId, "inactive-before")
  await adminClient()
    .from("nfc_cards")
    .update({ status: "inactive" })
    .eq("id", card.cardId)

  await page.goto(`/r/${card.publicId}`)
  await expect(
    page.getByRole("heading", { name: "Ez a kártya inaktív" })
  ).toBeVisible()
  await expect(page.getByRole("radio")).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0)
})

test("a card switched off after the page loads refuses the tap, saves nothing, offers no Google link", async ({
  page,
}) => {
  const card = await seedActiveCard(org.orgId, "inactive-race")
  const admin = adminClient()
  await admin
    .from("locations")
    .update({ google_review_url: "https://g.page/r/e2e-inactive-race" })
    .eq("id", card.locationId)

  await page.goto(`/r/${card.publicId}`)
  await admin
    .from("nfc_cards")
    .update({ status: "inactive" })
    .eq("id", card.cardId)

  await star(page, 5).click()
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Ez a kártya már nem aktív."
  )
  await expect(page.getByText(SAVED)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Újrapróbálom" })).toHaveCount(
    0
  )
  await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0)
  // Stars stay locked: retrying cannot succeed.
  await expect(star(page, 5)).toHaveAttribute("aria-disabled", "true")
  expect(await rowsFor(card.cardId)).toEqual([])
})
