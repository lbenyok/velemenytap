import { test, expect, type Page, type Route } from "@playwright/test"
import {
  seedReviewGatingOrg,
  cleanupOrg,
  fillRateLimitWindow,
  adminClient,
  type SeededOrg,
} from "./support/seed"

/**
 * The public rating flow, and the Review-Gating Regression Test from the
 * product skill.
 *
 * One tap on a star saves the rating. What follows is the SAME for every
 * rating: a confirmation, one "Értékelés a Google-on" link in the same place,
 * and an optional comment box. A flow that sends 4-5 stars straight to Google
 * and keeps 1-3 stars on a complaint form was asked for and declined -- it is
 * review gating (PRODUCT_SPEC.md, and Google's own policy). These tests are
 * what stop it creeping back in, including the direct 1-star-versus-5-star
 * comparison below.
 *
 * Every test that writes gets a card of its own (`ownCard`): the suite runs
 * fully parallel, and exact row-count assertions on a shared card would depend
 * on test order.
 */

const GOOGLE_URL = "https://g.page/r/e2e-test-review-link"
const SAVED = "Köszönjük, az értékelésedet elmentettük."
const COMMENT_LABEL = "Megjegyzés a vállalkozásnak (nem kötelező)"

let seeded: SeededOrg

test.beforeAll(async () => {
  seeded = await seedReviewGatingOrg()
})

test.afterAll(async () => {
  if (seeded) await cleanupOrg(seeded.orgId)
})

const star = (page: Page, rating: number) =>
  page.getByRole("radio", { name: new RegExp(`^${rating} csillag —`) })
const googleLink = (page: Page) =>
  page.getByRole("link", { name: "Értékelés a Google-on" })
const savedStatus = (page: Page) =>
  page.getByRole("status").filter({ hasText: SAVED })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fresh card at the seeded location, which has a valid Google URL. */
async function ownCard(name: string) {
  const { data, error } = await adminClient()
    .from("nfc_cards")
    .insert({
      organization_id: seeded.orgId,
      location_id: seeded.locationId,
      display_name: `E2E ${name}`,
    })
    .select("id, public_id")
    .single()
  if (error) throw error
  return { cardId: data.id, publicId: data.public_id }
}

async function rowsFor(cardId: number) {
  const { data, error } = await adminClient()
    .from("feedback")
    .select("rating, feedback_text")
    .eq("nfc_card_id", cardId)
  expect(error).toBeNull()
  return data ?? []
}

/** Intercepts this page's Server Action POSTs; page loads pass through. */
async function onSave(
  page: Page,
  publicId: string,
  handler: (route: Route, call: number) => Promise<void>
) {
  let call = 0
  await page.route(`**/r/${publicId}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    call += 1
    return handler(route, call)
  })
}

for (const rating of [1, 2, 3, 4, 5] as const) {
  test(`rating ${rating}: one tap saves it, then the Google link and the comment box`, async ({
    page,
  }) => {
    const card = seeded.cards.find((c) => c.rating === rating)!
    await page.goto(`/r/${card.publicId}`)

    await expect(
      page.getByText("Egy koppintás a csillagra el is küldi az értékelésedet.")
    ).toBeVisible()

    await star(page, rating).click()

    await expect(savedStatus(page)).toBeVisible()
    await expect(googleLink(page)).toBeVisible()
    await expect(googleLink(page)).toHaveAttribute("href", GOOGLE_URL)
    // Nothing claims a review was posted: opening Google publishes nothing.
    await expect(
      page.getByText(
        "A Google oldalán te írod meg és te teszed közzé az értékelést."
      )
    ).toBeVisible()
    await expect(page.getByLabel(COMMENT_LABEL)).toBeVisible()

    // Saved exactly once, with no text -- the star tap carries none.
    expect(await rowsFor(card.cardId)).toEqual([
      { rating, feedback_text: null },
    ])
  })
}

test("a 1-star and a 5-star customer are offered exactly the same thing", async ({
  page,
}) => {
  // Not "both have a link": the same link, label, styling, tab behaviour and
  // position. A quieter or lower CTA for low ratings would pass a presence
  // check and still be gating in practice.
  const read = async (rating: 1 | 5) => {
    const card = await ownCard(`compare ${rating}`)
    await page.goto(`/r/${card.publicId}`)
    await star(page, rating).click()
    await expect(savedStatus(page)).toBeVisible()
    const link = googleLink(page)
    const linkBox = (await link.boundingBox())!
    const commentBox = (await page.getByLabel(COMMENT_LABEL).boundingBox())!
    // The whole saved panel's markup, with only the comment prompt -- the one
    // thing allowed to differ -- normalised. Any rating-dependent wrapper,
    // class or element around the link shows up here, not just on the link.
    const panel = (await savedStatus(page).locator("xpath=..").innerHTML())
      .replace("Mondd el, min javíthatnánk!", "PROMPT")
      .replace("Mit szerettél a legjobban?", "PROMPT")
    return {
      panel,
      count: await link.count(),
      href: await link.getAttribute("href"),
      text: (await link.textContent())?.trim(),
      classes: await link.getAttribute("class"),
      target: await link.getAttribute("target"),
      top: Math.round(linkBox.y),
      linkAboveComment: linkBox.y < commentBox.y,
    }
  }

  const low = await read(1)
  const high = await read(5)
  expect(low).toEqual(high)
  expect(low.count).toBe(1)
  expect(low.linkAboveComment).toBe(true)
})

test("a low rating reaches Google in the same tab, without writing or sending anything", async ({
  page,
  context,
}) => {
  const card = await ownCard("low to google")
  const googleRequests: string[] = []
  await context.route("https://g.page/**", (route) => {
    googleRequests.push(route.request().url())
    return route.abort()
  })

  await page.goto(`/r/${card.publicId}`)
  await star(page, 2).click()
  await expect(
    page.getByRole("heading", { name: "Mondd el, min javíthatnánk!" })
  ).toBeVisible()

  const pagesBefore = context.pages().length
  await Promise.all([page.waitForRequest(GOOGLE_URL), googleLink(page).click()])
  expect(googleRequests).toEqual([GOOGLE_URL])
  expect(context.pages().length).toBe(pagesBefore)
  // The rating was already saved before Google was offered.
  expect(await rowsFor(card.cardId)).toEqual([
    { rating: 2, feedback_text: null },
  ])
})

test("a comment is attached to the rating the star tap saved", async ({
  page,
}) => {
  const card = await ownCard("comment")
  await page.goto(`/r/${card.publicId}`)
  await star(page, 1).click()
  await expect(savedStatus(page)).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Mondd el, min javíthatnánk!" })
  ).toBeVisible()

  // An empty comment is refused rather than "sent".
  await page.getByRole("button", { name: "Megjegyzés küldése" }).click()
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Írj egy rövid megjegyzést, vagy hagyd üresen a mezőt."
  )

  await page.getByLabel(COMMENT_LABEL).fill("Hideg volt a kávé.")
  await page.getByRole("button", { name: "Megjegyzés küldése" }).click()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Köszönjük, a megjegyzésedet továbbítottuk." })
  ).toBeVisible()
  await expect(googleLink(page)).toBeVisible()

  // One row, not two: the comment joined the saved rating.
  expect(await rowsFor(card.cardId)).toEqual([
    { rating: 1, feedback_text: "Hideg volt a kávé." },
  ])
})

test("a high rating gets its own prompt and the same comment box", async ({
  page,
}) => {
  const card = await ownCard("high prompt")
  await page.goto(`/r/${card.publicId}`)
  await star(page, 5).click()
  await expect(
    page.getByRole("heading", { name: "Mit szerettél a legjobban?" })
  ).toBeVisible()
  await expect(page.getByLabel(COMMENT_LABEL)).toBeVisible()
  await expect(googleLink(page)).toBeVisible()
})

test("re-tapping the card is refused as a duplicate and still offers Google", async ({
  page,
}) => {
  const card = await ownCard("duplicate")
  await page.goto(`/r/${card.publicId}`)
  await star(page, 4).click()
  await expect(savedStatus(page)).toBeVisible()

  await page.goto(`/r/${card.publicId}`)
  await star(page, 4).click()
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Ehhez a látogatáshoz már küldtél értékelést. Köszönjük!"
  )
  await expect(googleLink(page)).toHaveAttribute("href", GOOGLE_URL)
  // Not claimed as saved, not offered as a retry, and nothing written.
  await expect(page.getByText(SAVED)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Újrapróbálom" })).toHaveCount(
    0
  )
  expect(await rowsFor(card.cardId)).toHaveLength(1)
})

test("a rate-limited save is reported, not claimed, and still offers Google", async ({
  page,
}) => {
  const card = seeded.rateLimitCard
  await fillRateLimitWindow(seeded.orgId, seeded.locationId, card.cardId)

  await page.goto(`/r/${card.publicId}`)
  await star(page, 1).click()

  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Túl sok értékelés érkezett erről a kártyáról. Kérjük, próbáld újra pár perc múlva."
  )
  await expect(page.getByText(SAVED)).toHaveCount(0)
  await expect(googleLink(page)).toHaveAttribute("href", GOOGLE_URL)
})

test("repeated taps save once: in the same frame, and while the save is in flight", async ({
  page,
}) => {
  const card = await ownCard("repeated taps")
  await onSave(page, card.publicId, async (route) => {
    await delay(1500)
    await route.continue()
  })

  await page.goto(`/r/${card.publicId}`)
  // Three taps inside one frame -- React has not re-rendered between them, so
  // only the synchronous in-flight guard can stop the second and third.
  await page.evaluate(() => {
    const three = document.querySelector<HTMLButtonElement>(
      '[role="radio"][aria-label^="3 csillag"]'
    )!
    three.click()
    three.click()
    three.click()
  })

  // A short loading state while saving, with the stars locked.
  await expect(page.getByText("Mentés…")).toBeVisible()
  await expect(star(page, 3)).toHaveAttribute("aria-disabled", "true")
  // More taps during the save, including on a different star.
  await star(page, 3).click({ force: true })
  await star(page, 1).click({ force: true })

  await expect(savedStatus(page)).toBeVisible()
  // Let anything the extra taps might have queued finish (Next runs Server
  // Actions one after another, 1.5 s each here). Without the guard those
  // queued saves come back "duplicate" and REPLACE the saved screen with an
  // error -- one row in the database, and a customer told they already rated.
  await delay(6000)
  await expect(savedStatus(page)).toBeVisible()
  await expect(page.locator('p[role="alert"]')).toHaveCount(0)
  expect(await rowsFor(card.cardId)).toEqual([
    { rating: 3, feedback_text: null },
  ])
  await expect(star(page, 3)).toHaveAttribute("aria-checked", "true")
  await expect(star(page, 1)).toHaveAttribute("aria-checked", "false")
})

test("a failed save is never shown as saved, and offers a retry and Google", async ({
  page,
}) => {
  const card = await ownCard("failed save")
  // The first save never reaches the server; the retry does.
  await onSave(page, card.publicId, async (route, call) => {
    if (call === 1) return route.abort("failed")
    return route.continue()
  })

  await page.goto(`/r/${card.publicId}`)
  await star(page, 2).click()

  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Nem sikerült elmenteni az értékelésedet. Ellenőrizd a kapcsolatot, és próbáld újra."
  )
  await expect(page.getByText(SAVED)).toHaveCount(0)
  await expect(googleLink(page)).toHaveAttribute("href", GOOGLE_URL)
  expect(await rowsFor(card.cardId)).toEqual([])

  await page.getByRole("button", { name: "Újrapróbálom" }).click()
  await expect(savedStatus(page)).toBeVisible()
  expect(await rowsFor(card.cardId)).toEqual([
    { rating: 2, feedback_text: null },
  ])
})

test("a save that never answers is reported as unconfirmed, and a retry tells the truth", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const card = await ownCard("slow save")
  // The first save reaches the server only after the client has given up on
  // it (15 s), so it DOES land -- the case where "failed" would be a lie.
  await onSave(page, card.publicId, async (route, call) => {
    if (call === 1) await delay(17_000)
    await route.continue()
  })

  await page.goto(`/r/${card.publicId}`)
  await star(page, 5).click()
  await expect(page.getByText("Mentés…")).toBeVisible()

  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Nem tudtuk megerősíteni, hogy az értékelésed elmentődött. Kérjük, próbáld újra.",
    { timeout: 20_000 }
  )
  await expect(page.getByText(SAVED)).toHaveCount(0)
  await expect(googleLink(page)).toHaveAttribute("href", GOOGLE_URL)

  // Let the delayed save land, then retry: it is refused as a duplicate
  // rather than written twice, and the page says so.
  await expect
    .poll(async () => (await rowsFor(card.cardId)).length, {
      timeout: 20_000,
    })
    .toBe(1)
  await page.getByRole("button", { name: "Újrapróbálom" }).click()
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "Ehhez a látogatáshoz már küldtél értékelést. Köszönjük!"
  )
  expect(await rowsFor(card.cardId)).toHaveLength(1)
})

test("hovering or focusing a star saves nothing; a deliberate key press does", async ({
  page,
}) => {
  const card = await ownCard("keyboard")
  await page.goto(`/r/${card.publicId}`)

  await star(page, 5).hover()
  await star(page, 4).focus()
  await page.keyboard.press("Tab")
  await star(page, 1).focus()
  await delay(1000)
  await expect(page.getByText("Mentés…")).toHaveCount(0)
  await expect(page.getByText(SAVED)).toHaveCount(0)
  expect(await rowsFor(card.cardId)).toEqual([])

  await star(page, 2).focus()
  await page.keyboard.press("Enter")
  await expect(savedStatus(page)).toBeVisible()
  expect(await rowsFor(card.cardId)).toEqual([
    { rating: 2, feedback_text: null },
  ])
})
