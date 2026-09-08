import { describe, expect, it } from "vitest"
import { safeGoogleReviewUrl } from "./google-review-url"

describe("Google review destinations", () => {
  it.each([
    "https://g.page/r/e2e-test-review-link",
    "https://g.page/r/CcFSWGbfuT6_EAg/review",
    "https://g.page/my-business/review?hl=hu",
    "https://search.google.com/local/writereview?placeid=ChIJ-example_1&source=g.page",
    "https://maps.app.goo.gl/AJifjYmKEPzYX8k18?g_st=ic",
    "https://www.google.com/maps/reviews/?q=place_id:ChIJ-example_1",
    "https://google.com/maps/place/Cafe/data=!4m2!3m1!1s0x123",
    "https://maps.google.com/maps/place/Cafe",
  ])("preserves supported destination %s", (url) => {
    expect(safeGoogleReviewUrl(url)).toBe(new URL(url).href)
  })

  it.each([
    "https://attacker.example/reviews",
    "https://google.com.attacker.example/maps/reviews",
    "https://g.page.attacker.example/r/test/review",
    "https://g.page@attacker.example/r/test/review",
    "https://user:password@g.page/r/test/review",
    "https://g.page:444/r/test/review",
    "http://g.page/r/test/review",
    "javascript:alert(1)",
    "data:text/html,test",
    "//g.page/r/test/review",
    "https://",
    "https://www.google.com/url?q=https://attacker.example",
    "https://www.google.com/maps/../url?q=https://attacker.example",
    "https://www.google.com/maps/reviews/%2e%2e/%2e%2e/url?q=https://attacker.example",
    "https://www.google.com/maps/reviews/%2f..%2f..%2furl",
    "https://g.page/r/test/review?redirect=https://attacker.example",
    "https://maps.app.goo.gl/example?link=https://attacker.example",
    "https://maps.app.goo.gl/example?ofl=https://attacker.example",
    "https://search.google.com/local/writereview",
    "https://search.google.com/local/writereview?placeid=one&placeid=two",
    "https://search.google.com/url?placeid=test",
    "https://g.page/r/test\n/review",
    "https://g.page\\@attacker.example/r/test/review",
    "https://g.page./r/test/review",
    "",
    null,
    undefined,
  ])("does not label an unsafe destination as Google: %s", (url) => {
    expect(safeGoogleReviewUrl(url)).toBeNull()
  })

  it("trims copied surrounding whitespace without changing the destination", () => {
    expect(safeGoogleReviewUrl(" https://g.page/r/example/review \n")).toBe(
      "https://g.page/r/example/review"
    )
  })
})
