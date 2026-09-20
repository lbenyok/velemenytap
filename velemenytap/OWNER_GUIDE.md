# VéleményTap owner guide

Customer setup, NFC programming, handover and daily operation. Prepared 20 September 2026 from the current implementation. Hungarian button names below match the application. This is an operating guide, not a statement that every production launch check has passed.

## 1. What you are selling

The physical NFC card opens a customer-specific feedback link. The software subscription gives the business access to its dashboard: feedback, internal notes, statuses, statistics, locations and card controls.

- Storefront: https://velemenytap.hu
- Software: https://velemenytap.com
- Monthly subscription: **4,990 Ft**.
- Annual subscription: **49,900 Ft**, paid once per year. This saves **9,980 Ft** compared with twelve monthly payments.
- New organizations receive a **14-day trial without a bank card**, starting when the organization is created. Older organizations can have legacy grace access; they are not suitable for proving the new-customer trial behavior.
- Physical cards are sold separately. A Shopify card order does not automatically create a dashboard account, attach a card or activate a Stripe subscription. Fulfilment currently requires the steps below.
- The dashboard contains feedback submitted through VéleményTap. It does not import Google reviews or publish reviews on a guest's behalf.

An expired subscription restricts dashboard access; it does **not** automatically disable the public feedback link. Do not promise that nonpayment locks the physical card.

## 2. Before accepting the first paying customer

The software is deployed, but use this checklist to distinguish configuration from a proven customer journey.

| Check | Evidence / remaining action |
| --- | --- |
| Domain and pricing | The .com domain serves the application. This release aligns the annual display and checkout validation with Stripe's 49,900 Ft price. |
| Live Stripe configuration | Both Price IDs and both secret variable names were seen in Vercel Production; the subsequent redeployment was Ready. Secret values were not exposed or independently validated. |
| Webhook | Active endpoint at `https://velemenytap.com/api/webhooks/stripe`, API version `2026-08-26.dahlia`, with the three customer.subscription events and invoice.paid. No deliveries had occurred when checked. |
| Customer portal | A default live configuration exists; cancellation at the end of the billing period was enabled when checked. Confirm the app actually opens the portal after a purchase. |
| Real purchase | Still required: customer checkout, payment, successful webhook delivery, dashboard activation and portal cancellation. The purchaser completes any actual payment themselves. |
| Account emails on .com | Confirm a real signup and password-reset email both arrive and their links work on the .com domain. Previous checks on another host do not establish this. |
| Feedback alert | Test an authorized recipient on the actual production customer journey. A previously received test alert is useful evidence, but does not prove every production recipient. |
| Billing recovery schedule | The three latest recorded runs were successful when checked on 20 September; the newest started at 12:06 UTC / 14:06 Budapest, after the live configuration. [Run evidence](https://github.com/lbenyok/velemenytap/actions/runs/35509694064). This establishes successful execution, not a guarantee of an exact 15-minute cadence or a completed payment lifecycle. |
| Password protection | Verify Supabase's “Require current password when changing password” setting and the existing enforcement check; older launch notes leave this open. |
| Physical NFC tap | Pending until a real card is available. A working browser link alone is not an NFC hardware test. |
| Business setup | Finalize your support contact, business identity, customer terms/privacy information, refund handling and invoicing arrangement. The repo's BUSINESS_DECISIONS.md records these as open; this guide does not assume they are resolved. |

For the billing schedule, Vercel Production and GitHub Actions need the same `RECONCILE_SWEEP_SECRET`. The GitHub variable `PRODUCTION_RECONCILE_SWEEP_URL` should point to `https://velemenytap.com/api/admin/reconcile-billing-sweep`. Keep secret values in the services' secret settings, never in an order spreadsheet, a card or customer instructions. Have the operator verify a successful run and response, rather than merely checking the setting names.

## 3. Information to collect for each order

Keep a fulfilment record containing the Shopify order reference, business name, customer contact, account email, location names, Google review link for each location, requested number of cards and delivery details already collected for the order. Record the agreed hardware price separately from the software subscription.

Ask who should receive low-rating alerts. Do not ask for the customer's email password, Google password, Stripe credentials or banking credentials.

There is currently **no platform-owner dashboard for all customers**, no organization switcher and no built-in staff invitation flow. Each customer should create and own their account. Help them while they are signed in, for example during a screen-sharing setup session. Do not put unrelated businesses inside your own organization: that mixes their data. Your ordinary login cannot manage another customer's cards.

## 4. Create the customer's account

1. Have the customer visit https://velemenytap.com/signup and register with their own email and password.
2. Have them open the confirmation email and follow its link. They should finish signed in, on the organization setup page.
3. Enter **Vállalkozás neve** and select **Tovább**. This creates their business and starts the trial.
4. Follow the dashboard tour. Use https://velemenytap.com/dashboard to return later.
5. Confirm the correct business name is shown before creating any locations or cards.

If the email does not arrive, check spam and the entered address, then use the resend option. Repeated resends can hit email limits. If confirmation or recovery fails, stop onboarding and check the email configuration; do not work around it by giving customers your own account.

## 5. Add locations and Google review links

1. Open https://velemenytap.com/dashboard/locations (**Helyszínek**).
2. Add a location with **Helyszín neve**, optional **Cím**, and its **Google-értékelés link**.
3. To obtain that link, the business owner opens their Google Business Profile, selects **Read reviews → Get more reviews**, and copies the review link. Google may show translated labels. [Google's instructions](https://support.google.com/business/answer/16816815?hl=en-GB).
4. Paste the exact HTTPS review link, then save with **Helyszín hozzáadása**.
5. Open the saved Google link yourself and check it belongs to the correct business and branch. Do not submit a fabricated Google review as a test.

The Google link can be added later, but Google routing cannot work without it. The application accepts supported Google review destinations, not arbitrary websites. If validation rejects a link, obtain the review link from Google Business Profile rather than inventing or shortening one.

## 6. Create the digital record for each physical card

1. Open https://velemenytap.com/dashboard/nfc-cards (**NFC kártyák**).
2. Select **NFC kártya hozzáadása**.
3. Choose the correct **Helyszín**. This assignment cannot be changed after creation in the current software.
4. Enter a useful **Kártya neve**, such as `Reception 01`, `Counter 02` or `Table 4`.
5. Select **Kártya hozzáadása** and check the row shows **Aktív**.
6. Copy the row's public link. It has the form `https://velemenytap.com/r/<unique-public-id>`.
7. Use **Kipróbálás** to check that the page opens for the intended location.

Use a separate digital card record for each physical card when you need independent statistics or deactivation. Writing the same link to several cards makes them share that identity: deactivating it affects every physical copy.

The card table also provides a CSV export for preparing multiple cards. Treat the export as an inventory of links, not an automatic NFC writer. Keep a physical label or fulfilment record matching each card name to its link and customer.

## 7. Write the NFC card

You need a writable NFC tag/card, a compatible NFC-capable phone and a writing application. NFC Tools by wakdev supports writing a URL record. Follow the vendor's [URL-writing guide](https://www.wakdev.com/en/knowledge-base/how-to-guides/how-to-write-a-link-url-on-an-nfc-chip.html):

1. In NFC Tools, open **Write → Add a record → URL / URI**.
2. Paste the complete public link copied from the customer's card row, including `https://` exactly once.
3. Confirm the record. The intended record is the VéleményTap URL, not the direct Google link or dashboard URL.
4. Choose **Write**, hold that one card against the phone's NFC reading area and wait for success.
5. Read the card back and compare the stored URL with the fulfilment record.
6. Test a normal phone tap outside the writing app. Depending on the phone, the guest may need to tap a notification to open the page. Internet access is needed to load it.

Dashboard deactivation and a tag's write-protection are different things. Deactivation is reversible in VéleményTap. Do not select a tag's permanent/read-only lock during initial setup; keep it rewritable until the correct URL and hardware behavior have been checked. This guide does not require physically locking the tag.

If the card does not scan, first open its URL manually. If the URL works, check the phone's NFC support/settings, the card's position and whether the card is damaged or already write-protected. Changing software settings will not repair a damaged NFC chip.

## 8. Configure and verify alert emails

1. Open https://velemenytap.com/dashboard/settings (**Beállítások**).
2. Enter the customer's chosen **Értesítési e-mail cím** and select **Változtatások mentése**.
3. The recipient must click the confirmation link sent to the new address. Until then, the new address is not active for alerts.
4. If left blank, eligible organization members are the fallback recipients. For a newly created account with one owner, that means the owner; this does not imply staff invitations exist.
5. With the customer's permission, submit one clearly labelled low-rating test through a dedicated setup card and confirm the email arrives.

The current threshold is **1–3 stars**. There is a five-minute cooldown per card and a budget of **30 alert sends per organization per hour**. Sending is separate from saving the feedback: delivery can fail, and suppressed alerts are not promised a later digest. Check the dashboard even when no email arrives. The app currently has no customer-facing switch to change these limits or threshold.

## 9. Understand and test the guest journey

The guest chooses a star rating and presses **Vélemény küldése**; choosing stars alone is not a completed submission.

- **1–3 stars:** the guest can add a comment. Sending saves the internal feedback; the confirmation screen includes the small Google button when a valid Google link is configured.
- **4–5 stars:** the send action opens the configured Google review page in a new tab and starts saving the rating on the original page. Check the original page for the save result. The Google review itself still requires the guest to complete it on Google.
- **No Google link:** the internal feedback can still be submitted, but no Google destination can be opened.
- **Inactive card or location:** the feedback page stops accepting submissions. A form opened before deactivation must also be rejected when submitted afterward.

For each customer, confirm the saved rating appears under the correct location and card at https://velemenytap.com/dashboard/feedback. Test both rating paths with clearly labelled setup feedback and the recipient's permission. Duplicate/rate limits can prevent repeated tests from the same browser; do not disable those safeguards to make a test pass. The homepage's star picker is explicitly a demonstration and saves nothing.

## 10. “Lock” and unlock a card remotely

Card controls require dashboard access through an active trial, subscription or existing grace entitlement. On a phone, open the dashboard menu to find them. Go to **NFC kártyák**, find the card and click **Deaktiválás**. Wait for **Inaktív**. Refresh its public link and check that it says the card is not active. Existing feedback is retained.

To restore it, select **Aktiválás**, wait for **Aktív**, then reopen the same link. You do not rewrite the NFC card for this operation. If an error appears, the change is not confirmed; resolve it before telling the customer the card is disabled.

Deactivation blocks that public link, including copies of it; it does not turn off the chip, remove existing Google reviews or prevent someone from opening Google directly. Deactivating a location also makes its cards unavailable. If an activated card still appears inactive, check the location too.

If a card must move to another location, the current app requires a new card record for that location and a new URL written to the physical card. Deactivate the old record and retain its history. This is different from simple activation/deactivation, which preserves the URL.

## 11. Start the software subscription

Have the customer open https://velemenytap.com/dashboard/billing (**Számlázás**), choose monthly or yearly and continue to Stripe. The customer enters their own payment information and completes payment. Buying the hardware in Shopify does not count as this subscription payment.

Before completing the first live purchase, verify Stripe displays **4,990 Ft/month** or **49,900 Ft/year**, as selected. After payment, return to the application and verify the billing state and dashboard access. In Stripe, verify the real payment and webhook delivery succeeded. Merely arriving on a success URL is not evidence that payment was confirmed.

From the billing page, open the subscription-management portal and check that the customer can view billing details and cancel renewal. The currently observed portal setting cancels at the end of the paid period. Follow your published refund and invoicing terms; do not promise a refund or locally compliant invoice solely because Stripe generated a document.

## 12. Customer handover checklist

- [ ] Customer owns the login and can sign in independently.
- [ ] Correct business, location and Google review destination verified.
- [ ] Each card is named, mapped to its customer and written with its own .com public URL.
- [ ] Normal NFC tap checked on available customer phones.
- [ ] Both feedback paths checked; saved entries visible in the correct dashboard.
- [ ] Notification address confirmed and one authorized alert received.
- [ ] Deactivation and reactivation demonstrated without rewriting the tag.
- [ ] Customer shown **Vélemények**, **Elemzés**, **NFC kártyák**, **Beállítások** and **Számlázás**.
- [ ] Subscription choice, hardware charge, cancellation and support contact explained.
- [ ] Order record marked ready only after these checks; unresolved items written down.

Give the customer their dashboard link, card inventory and your real support contact. Keep passwords and secret keys out of the handover.

## 13. Daily operation and support

Customers use **Vélemények** to filter feedback, add **Belső megjegyzés**, and move items through **Új → Folyamatban → Megoldva**. Internal notes and status changes do not reply to guests or post on Google. **Elemzés** shows the internal feedback trends and breakdowns.

| Symptom | First checks |
| --- | --- |
| Card opens the wrong business | Read the stored URL; compare it with the correct customer's card record and Google link. |
| Card says inactive | Check both card and location status in the customer's account. |
| Google does not open | Verify the location's saved Google review URL, then the device/browser behavior. |
| Rating missing | Check the original page's save result, correct business/card filters and duplicate/rate-limit messages. A Google tab opening is not proof of an internal save. |
| Alert missing | Confirm rating is 1–3, recipient verification, spam folder and alert limits; then inspect delivery logs. |
| Payment taken but access missing | Record the Stripe payment/subscription IDs, inspect webhook delivery and billing reconciliation. Do not ask the customer to pay again to repair access. |
| Customer forgot password | Use the login page's password-reset flow. Never send a shared password. |

As the platform owner, monitor failed Vercel requests, failed Stripe webhook deliveries, the scheduled billing workflow and email delivery failures. Keep an up-to-date fulfilment record and a tested backup/recovery procedure. A green deployment means the app built; it does not replace these operating checks.
