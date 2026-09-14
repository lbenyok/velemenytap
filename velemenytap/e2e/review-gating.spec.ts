import { test, expect } from "@playwright/test"
import {
  seedReviewGatingOrg,
  cleanupOrg,
  fillRateLimitWindow,
  adminClient,
  type SeededOrg,
} from "./support/seed"

/**
 * The Review-Gating Regression Test from the product skill, automated: the
 * Google Review CTA must be available after every rating from 1 to 5,
 * identically. This is the single most important invariant in the product
 * (see PRODUCT_SPEC.md "The one rule that overrides everything else") --
 * this suite is what makes that a checked fact instead of a manual step.
 */

let seeded: SeededOrg

test.beforeAll(async () => {
  seeded = await seedReviewGatingOrg()
})

test.afterAll(async () => {
  // If beforeAll threw, `seeded` is undefined and cleanup has nothing to do --
  // without this guard the resulting TypeError is reported instead of the
  // seed error that actually caused it.
  if (seeded) await cleanupOrg(seeded.orgId)
})

for (const rating of [1, 2, 3, 4, 5] as const) {
  test(`rating ${rating} -> Google Review CTA is available`, async ({
    page,
  }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!
    await page.goto(`/r/${card.publicId}`)

    await page
      .getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })
      .click()

    await page.getByRole("button", { name: "Csak elküldöm" }).click()

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
  await page.getByRole("radio", { name: /^5 csillag —/ }).click()
  await page.getByRole("button", { name: "Csak elküldöm" }).click()
  await expect(page.getByRole("heading", { name: "Köszönjük!" })).toBeVisible()

  // Same browser context/cookies, same card, a second tap.
  await page.goto(`/r/${card.publicId}`)
  await page.getByRole("radio", { name: /^5 csillag —/ }).click()
  await page.getByRole("button", { name: "Csak elküldöm" }).click()

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
  await page.getByRole("button", { name: "Csak elküldöm" }).click()

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

/**
 * Round-16: the flow got shorter, and this is what stops it getting shorter
 * unequally.
 *
 * "Send and write a Google review" is now the primary action on the rating
 * screen itself, so reaching Google costs two taps instead of three. The
 * request that prompted it was to send 4-5 stars straight through while 1-3
 * stars kept the longer path — which is review gating, the one thing
 * PRODUCT_SPEC.md forbids outright and the pattern Google penalises profiles
 * for. It was declined and the friction was removed for every rating instead.
 *
 * A future change that "optimises" this per rating has to get past these.
 */
for (const rating of [1, 2, 3, 4, 5] as const) {
  test(`rating ${rating} reaches Google in the same two taps as every other`, async ({
    page,
  }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!
    await page.goto(`/r/${card.publicId}`)
    await page
      .getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })
      .click()

    // Tap two is on the rating screen itself -- no send-then-find-the-button.
    const primary = page.getByRole("link", {
      name: "Küldés és Google-értékelés írása",
    })
    await expect(primary).toBeVisible()
    await expect(primary).toHaveAttribute(
      "href",
      "https://g.page/r/e2e-test-review-link"
    )

    // And the customer who does not want Google is never stranded.
    await expect(
      page.getByRole("button", { name: "Csak elküldöm" })
    ).toBeVisible()
  })
}

test("the Google action and the plain send are the same for a 1 star and a 5 star", async ({
  page,
}) => {
  // Not just "both present" -- the same accessible name and the same
  // destination. A rating that got a quieter label or a longer route would
  // satisfy the per-rating tests above while still being gating in practice.
  const read = async (r: 1 | 5) => {
    const card = seeded.cards.find((c) => c.rating === r)!
    await page.goto(`/r/${card.publicId}`)
    await page
      .getByRole("radio", { name: new RegExp(`^${r} csillag —`) })
      .click()
    const link = page.getByRole("link", {
      name: "Küldés és Google-értékelés írása",
    })
    return {
      href: await link.getAttribute("href"),
      text: (await link.textContent())?.trim(),
      classes: await link.getAttribute("class"),
    }
  }

  const low = await read(1)
  const high = await read(5)
  expect(low).toEqual(high)
})

/**
 * The half the per-rating tests above cannot see: that the primary action
 * KEEPS the first of its two promises.
 *
 * "Küldés és Google-értékelés írása" claims to do two things, and the tests
 * above only check the second -- the href. If requestSubmit() stopped firing,
 * every one of them would still pass while the customer's feedback quietly
 * went nowhere and the business never heard the complaint it exists to catch.
 */
test("the primary action really submits the feedback, not just opens Google", async ({
  page,
  context,
}) => {
  // The popup is allowed to open -- that is the behaviour under test -- but
  // its navigation is aborted so the suite never actually calls out to Google.
  // What the browser ASKED for is recorded first: that, not the aborted tab's
  // own url, is the evidence it was sent to the right place.
  const googleRequests: string[] = []
  await context.route("https://g.page/**", (route) => {
    googleRequests.push(route.request().url())
    return route.abort()
  })

  const card = seeded.primaryActionCard
  await page.goto(`/r/${card.publicId}`)
  await page.getByRole("radio", { name: /^2 csillag —/ }).click()
  await page.getByLabel("Megjegyzés (nem kötelező)").fill("E2E primary-action submission")

  const popupPromise = context.waitForEvent("page")
  await page
    .getByRole("link", { name: "Küldés és Google-értékelés írása" })
    .click()

  // The tab the customer is left on shows the confirmation, so the send half
  // ran in the page rather than being lost to the navigation.
  await expect(page.getByRole("heading", { name: "Köszönjük!" })).toBeVisible()

  const popup = await popupPromise
  await popup.close()
  expect(googleRequests).toEqual(["https://g.page/r/e2e-test-review-link"])

  // And it reached the database, with the rating and text the customer gave.
  const { data, error } = await adminClient()
    .from("feedback")
    .select("rating, feedback_text")
    .eq("nfc_card_id", card.cardId)
  expect(error).toBeNull()
  expect(data).toEqual([
    { rating: 2, feedback_text: "E2E primary-action submission" },
  ])
})
