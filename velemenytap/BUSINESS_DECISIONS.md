# Open business decisions

Not engineering questions. Each one blocks launch in its own way, and none can be
settled from inside this repository. Grouped here so they are decided together rather
than discovered one at a time.

**A note on how this file is written.** Where something has not been verified, it says
so. In particular, nothing below should be read as legal or accounting advice, and the
invoicing section deliberately does not assert what Hungarian law requires — that is
the point of it.

---

## 1. Physical NFC card price

**Status: unresolved, and deliberately unpublished.**

A parallel implementation's marketing copy stated **6,990 Ft** for the physical card.
That figure has **no source anywhere in this repository**, and the card is sold through
a separate, password-protected storefront that could not be checked. It was therefore
not published.

Today the homepage renders subscription prices from `PLAN_PRICING` (so the marketing
number and the in-app number cannot drift apart) and says the card is ordered
separately — **it states no card price at all.**

- [ ] Confirm the current selling price, or confirm that the site should keep quoting
      none and link to the storefront instead.
- [ ] If a price is published, decide whether it is gross or net, and whether it
      includes shipping.

## 2. Invoicing

**Status: unresolved. Requires your accountant, not a developer's reading of the rules.**

What is established, because it is observable:

- Stripe issues **receipts**. It does not, in this configuration, issue documents that
  have been confirmed to satisfy Hungarian invoicing requirements.
- Nothing in this application currently generates an invoice, assigns an invoice
  number, or reports anything to NAV.
- Prices are displayed as VAT-inclusive ("Az árak az ÁFát tartalmazzák").

What is **not** established, and must not be treated as though it were:

- Whether your specific business is obliged to issue invoices for these subscription
  charges, and in what form.
- Whether real-time invoice reporting (NAV Online Számla) applies to you, from what
  threshold, and on what timetable.
- Whether selling to customers outside Hungary changes the answer.
- Whether an integration (Számlázz.hu, Billingo or similar) is required, merely
  convenient, or unnecessary.
- Whether Stripe Tax needs to be enabled, and what it would and would not cover.

These are questions for your accountant. Please do not let this repository's
documentation — or my earlier summaries of it — stand in for that advice.

- [ ] Ask your accountant the five questions above, in writing.
- [ ] Record the answer here, with the date and who gave it.
- [ ] Only then decide whether an invoicing integration is in scope before launch.

## 3. Business identity

Needed before taking money, and needed as *content* before the legal documents below
can be written.

- [ ] Legal entity name and form (egyéni vállalkozó / Kft. / other).
- [ ] Registered address.
- [ ] Tax number (adószám), and EU VAT number if applicable.
- [ ] Company registration or sole-trader registration number.
- [ ] Bank account details, to the extent they need to appear anywhere customer-facing.

## 4. Legal documents

None of these exist today. Their **content** depends on §3 and on the answer to §2.

- [ ] **Impresszum** — the identity details from §3.
- [ ] **ÁSZF** (terms) — covering the subscription itself: what is sold, the 14-day
      no-card trial, billing cadence, cancellation, refunds, and the separately-sold
      physical card.
- [ ] **Adatkezelési tájékoztató** (privacy policy) — must reflect what the product
      actually does: end-customer feedback is collected without accounts, ratings and
      optional free-text comments are stored against a business, and Stripe processes
      payment data. Whoever drafts it should be shown `PRODUCT_SPEC.md` and
      `DATABASE_SCHEMA.md` rather than working from a template.
- [ ] Decide whether these are lawyer-drafted or template-based, and who signs off.
- [ ] Decide where they live: routes in this app, or hosted elsewhere and linked.

## 5. Support contact

- [ ] The address customers actually reach you at, and who monitors it.
- [ ] Whether it differs from the alert/notification sender identity (§1 of
      `LAUNCH_CHECKLIST.md`).
- [ ] A stated response-time expectation, if the ÁSZF commits to one.

---

## Dependency order

§3 (identity) feeds §4 (legal documents). §2 (invoicing) may add scope to the product
itself and is the one with the longest lead time, because it depends on someone else's
availability — **start it first.** §1 and §5 are independent and quick.
