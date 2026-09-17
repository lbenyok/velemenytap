import { test, expect } from "@playwright/test"
import {
  seedReviewGatingOrg,
  cleanupOrg,
  fillRateLimitWindow,
  adminClient,
  type SeededOrg,
} from "./support/seed"

// Every rating retains a Google review link after submission.
let seeded: SeededOrg

test.beforeAll(async () => {
  seeded = await seedReviewGatingOrg()
})

test.beforeEach(async ({ context }) => {
  await context.route("https://g.page/**", (route) => route.abort())
})

test.afterAll(async () => {
  // If beforeAll threw, `seeded` is undefined and cleanup has nothing to do --
  // without this guard the resulting TypeError is reported instead of the
  // seed error that actually caused it.
  if (seeded) await cleanupOrg(seeded.orgId)
})

for (const rating of [1, 2, 3] as const) {
  test(`rating ${rating} -> Google Review CTA is available`, async ({
    page,
  }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!
    await page.goto(`/r/${card.publicId}`)

    await page
      .getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })
      .click()

    await page.getByRole("button", { name: "Vélemény küldése" }).click()

    await expect(
      page.getByRole("heading", { name: "Köszönjük!" })
    ).toBeVisible()

    const cta = page.getByRole("link", { name: "Google-értékelés írása" })
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute(
      "href",
      "https://g.page/r/e2e-test-review-link"
    )
  })
}

test("duplicate submission on the same card is rejected, not silently double-counted", async ({
  page,
}) => {
  const card = seeded.cards.find((c) => c.rating === 5)!
  await page.goto(`/r/${card.publicId}`)
  await page.getByRole("radio", { name: /^3 csillag —/ }).click()
  await page.getByRole("button", { name: "Vélemény küldése" }).click()
  await expect(page.getByRole("heading", { name: "Köszönjük!" })).toBeVisible()

  // Same browser context/cookies, same card, a second tap.
  await page.goto(`/r/${card.publicId}`)
  await page.getByRole("radio", { name: /^3 csillag —/ }).click()
  await page.getByRole("button", { name: "Vélemény küldése" }).click()

  await expect(
    page.getByText("Ehhez a látogatáshoz már küldtél véleményt.")
  ).toBeVisible()

  // The half this test used to leave out, and the reason the defect survived
  // this long: it asserted the guard fired and never asked what the CUSTOMER
  // was left with. Re-tapping a card is exactly what someone does when they
  // lost the confirmation screen and wanted the Google button -- and that was
  // the one path that refused to give it to them.
  const cta = page.getByRole("link", { name: "Google-értékelés írása" })
  await expect(cta).toBeVisible()
  await expect(cta).toHaveAttribute(
    "href",
    "https://g.page/r/e2e-test-review-link"
  )
})

/**
 * The same requirement on the other blameless failure. A busy card that has
 * hit its per-card rate limit did not record this customer's feedback -- which
 * is no reason at all to take away their route to Google.
 *
 * Deliberately NOT asserted for the inactive-card or unknown-failure paths:
 * there the business has switched the card off, or retrying is the right next
 * action, and sending the customer elsewhere would be wrong.
 */
test("a rate-limited submission still offers the Google Review CTA", async ({
  page,
}) => {
  // A card of its own, deliberately: filling the window on one of the five
  // shared cards would fail whichever rating test happened to run after it,
  // and `fullyParallel` means that order is not fixed.
  const card = seeded.rateLimitCard
  await fillRateLimitWindow(seeded.orgId, seeded.locationId, card.cardId)

  await page.goto(`/r/${card.publicId}`)
  await page.getByRole("radio", { name: /^1 csillag —/ }).click()
  await page.getByRole("button", { name: "Vélemény küldése" }).click()

  await expect(
    page.getByText("Túl sok vélemény érkezett erről a kártyáról.")
  ).toBeVisible()

  const cta = page.getByRole("link", { name: "Google-értékelés írása" })
  await expect(cta).toBeVisible()
  await expect(cta).toHaveAttribute(
    "href",
    "https://g.page/r/e2e-test-review-link"
  )
})

// Low ratings send feedback first; high ratings offer Google immediately.
for (const rating of [1, 2, 3, 4, 5] as const) {
  test(`rating ${rating} shows the expected initial action`, async ({
    page,
  }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!
    await page.goto(`/r/${card.publicId}`)
    await page
      .getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })
      .click()

    const primary = page.getByRole("link", {
      name: "Vélemény küldése",
    })
    const sendOnly = page.getByRole("button", { name: "Vélemény küldése" })
    if (rating <= 3) {
      await expect(sendOnly).toBeVisible()
      await expect(primary).toHaveCount(0)
    } else {
      await expect(sendOnly).toHaveCount(0)
      await expect(primary).toBeVisible()
      await expect(primary).toHaveAttribute(
        "href",
        "https://g.page/r/e2e-test-review-link"
      )
    }
  })
}

test("low and high ratings use the same Google destination", async ({
  page,
}) => {
  // Compare the low-rating confirmation link with the high-rating initial link.
  const read = async (r: 1 | 5) => {
    const card = seeded.cards.find((c) => c.rating === r)!
    await page.goto(`/r/${card.publicId}`)
    await page
      .getByRole("radio", { name: new RegExp(`^${r} csillag —`) })
      .click()
    if (r === 1) {
      await page.getByRole("button", { name: "Vélemény küldése" }).click()
      await expect(
        page.getByRole("heading", { name: "Köszönjük!" })
      ).toBeVisible()
    }
    const link = page.getByRole("link", {
      name: r === 1 ? "Google-értékelés írása" : "Vélemény küldése",
    })
    return link.getAttribute("href")
  }

  const low = await read(1)
  const high = await read(5)
  expect(low).toEqual(high)
})

test("high ratings open Google and save each rating to the dashboard", async ({
  page,
  context,
}) => {
  const card = seeded.primaryActionCard
  await context.route("https://g.page/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Google destination</h1>",
    })
  )
  for (const rating of [4, 5]) {
    await context.clearCookies()
    await page.goto("/r/" + card.publicId)
    await page
      .getByRole("radio", { name: new RegExp("^" + rating + " csillag —") })
      .click()
    await expect(page.getByRole("textbox")).toHaveCount(0)
    const popupPromise = context.waitForEvent("page")
    await page.getByRole("link", { name: "Vélemény küldése" }).click()
    const popup = await popupPromise
    await expect(popup).toHaveURL("https://g.page/r/e2e-test-review-link")
    await expect(
      page.getByRole("heading", { name: "Köszönjük!" })
    ).toBeVisible()
    await popup.close()
  }
  const { data, error } = await adminClient()
    .from("feedback")
    .select("rating")
    .eq("nfc_card_id", card.cardId)
    .order("rating")
  expect(error).toBeNull()
  expect(data).toEqual([{ rating: 4 }, { rating: 5 }])
})
