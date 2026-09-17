import { test, expect } from "@playwright/test"
import {
  adminClient,
  seedOrgWithMember,
  seedActiveCard,
  cleanupOrgWithMember,
} from "./support/seed"
import { signInViaUi } from "./support/ui"

test("all five public ratings appear in the business dashboard", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const member = await seedOrgWithMember("rating-dashboard")
  try {
    await context.route("https://g.page/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "Google review destination",
      })
    )
    for (const rating of [1, 2, 3, 4, 5]) {
      const card = await seedActiveCard(member.orgId, "rating-" + rating)
      const { error } = await adminClient()
        .from("locations")
        .update({ google_review_url: "https://g.page/r/test/review" })
        .eq("id", card.locationId)
      expect(error).toBeNull()
      await page.goto("/r/" + card.publicId)
      await page
        .getByRole("radio", { name: new RegExp("^" + rating + " csillag —") })
        .click()
      if (rating < 4) {
        await page.getByRole("button", { name: "Vélemény küldése" }).click()
      } else {
        const popupPromise = context.waitForEvent("page")
        await page.getByRole("link", { name: "Vélemény küldése" }).click()
        const popup = await popupPromise
        await expect(popup).toHaveURL("https://g.page/r/test/review")
        await popup.close()
      }
      await expect(
        page.getByRole("heading", { name: "Köszönjük!" })
      ).toBeVisible()
    }
    await signInViaUi(
      page,
      member.email,
      member.password,
      "/dashboard/feedback"
    )
    await expect(page.locator("table tbody tr")).toHaveCount(5)
    for (const rating of [1, 2, 3, 4, 5]) {
      await expect(
        page.locator('table [aria-label="' + rating + '/5 csillag"]')
      ).toHaveCount(1)
    }
  } finally {
    await cleanupOrgWithMember(member.userId, member.orgId)
  }
})
