/**
 * Supported HTTPS link families: g.page/r/<id>[/review], legacy
 * g.page/<name>/review, search.google.com/local/writereview?placeid=<id>,
 * maps.app.goo.gl/<id>, and Google Maps /maps/reviews or /maps/place links.
 * Only exact Google hosts are trusted, never generic Google redirect routes.
 * This validates a destination's shape, not that Google still serves the place.
 * Business Profile owners should copy their link from Google's review-link UI:
 * https://support.google.com/business/answer/16816815
 */
export function safeGoogleReviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const raw = value.trim()
  if (!raw || raw.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(raw))
    return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null
  if (/%(?:2f|5c|0[0-9a-f]|7f)/i.test(url.pathname)) return null

  // Short/deep links can accept fallback URLs. Never allow a supplied
  // off-site redirect/fallback to turn a Google-labelled CTA into phishing.
  const forbiddenParameters = new Set([
    "url",
    "redirect",
    "redirect_uri",
    "redirect_url",
    "continue",
    "next",
    "link",
    "afl",
    "ifl",
    "ofl",
    "fallback",
    "fallback_url",
  ])
  for (const key of url.searchParams.keys()) {
    if (forbiddenParameters.has(key.toLowerCase())) return null
  }

  let accepted = false
  if (url.hostname === "g.page") {
    accepted =
      /^\/r\/[A-Za-z0-9_-]+(?:\/review)?\/?$/.test(url.pathname) ||
      /^\/[A-Za-z0-9_-]+\/review\/?$/.test(url.pathname)
  } else if (url.hostname === "search.google.com") {
    accepted =
      /^\/local\/writereview\/?$/.test(url.pathname) &&
      url.searchParams.getAll("placeid").length === 1 &&
      /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("placeid") ?? "")
  } else if (url.hostname === "maps.app.goo.gl") {
    accepted = /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  } else if (
    ["google.com", "www.google.com", "maps.google.com"].includes(url.hostname)
  ) {
    accepted =
      /^\/maps\/reviews(?:\/|$)/.test(url.pathname) ||
      /^\/maps\/place(?:\/|$)/.test(url.pathname)
  }
  return accepted ? url.href : null
}
