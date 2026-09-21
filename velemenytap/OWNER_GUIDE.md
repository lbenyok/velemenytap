# VéleményTap owner guide

Customer setup, NFC programming, handover and daily operation. Updated 21 September 2026 from the current implementation. Hungarian button names below match the application. This is an operating guide, not a statement that every production launch check has passed.

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
| Password protection | Production setting observed enabled on 21 September. The isolated-project direct-API enforcement test passed; a separate fresh production attack simulation was not performed. |
| Physical NFC tap | Pending until a real card is available. A working browser link alone is not an NFC hardware test. |
| Business setup | Finalize your support contact, business identity, customer terms/privacy information, refund handling and invoicing arrangement. The repo's BUSINESS_DECISIONS.md records these as open; this guide does not assume they are resolved. |

For the billing schedule, Vercel Production and GitHub Actions need the same `RECONCILE_SWEEP_SECRET`. The GitHub variable `PRODUCTION_RECONCILE_SWEEP_URL` should point to `https://velemenytap.com/api/admin/reconcile-billing-sweep`. Keep secret values in the services' secret settings, never in an order spreadsheet, a card or customer instructions. Have the operator verify a successful run and response, rather than merely checking the setting names.

## 3. Information to collect for each order

Keep a fulfilment record containing the Shopify order reference, business name, customer contact, account email, location names, Google review link for each location, requested number of cards and delivery details already collected for the order. Record the agreed hardware price separately from the software subscription.

Ask who should receive low-rating alerts. Do not ask for the customer's email password, Google password, Stripe credentials or banking credentials.

The platform-owner card panel is at **https://velemenytap.com/admin**, restricted to explicitly approved owner accounts. It lets you find a customer and lock/unlock their cards without their password; see [the platform-admin guide](PLATFORM_ADMIN.md). An ordinary business-owner login cannot manage other customers. There is still no customer organization switcher, staff invitation flow or impersonation feature. Each customer should create and own their account. Help them with initial setup while they are signed in, for example during screen sharing. Do not put unrelated businesses inside your own organization: that mixes their data.

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

**For you as platform owner:** open https://velemenytap.com/admin, find the customer,
open their card, enter a reason and choose **Kártya zárolása**. Only a platform
admin can lift that lock, using **Zárolás feloldása**. The previous active/inactive
state is restored and both operations are recorded in the internal audit log.
This panel does not depend on your own software subscription.

**For a customer managing their own cards:** the ordinary reversible activation
controls below remain available unless you have applied a platform lock.

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

## 14. Connect the shop, subscription and card — the actual workflow

There is no automatic Shopify-to-VéleményTap provisioning integration in this release. You can sell the combined offer now through a **manual, assisted setup process**, once the launch checks in section 2 are completed. Do not tell customers that a Shopify purchase has already activated their subscription.

| Part | Where it happens | What connects it |
| --- | --- | --- |
| Card purchase and shipping | velemenytap.hu / Shopify | Your order and fulfilment record |
| Customer account and business | velemenytap.com | The customer's verified login and organization |
| Subscription | The customer's Számlázás page → Stripe | The application creates Checkout with that organization's identity |
| Physical card | NFC Tools | The exact `/r/<public-id>` URL written to its chip |
| Feedback and Google destination | The location and card in VéleményTap | The card's existing business/location assignment |
| Your remote lock | velemenytap.com/admin | The specific digital card record; all physical copies of that URL follow its state |

**The shortest safe order of operations:** card order → customer signs up → create location → create digital card → copy its link → program physical card → test feedback and email → customer chooses software billing → hand over and ship. The customer can choose billing during the trial; you do not need their bank-card details. Their trial starts at business creation, so avoid creating their business weeks before fulfilment.

Do not create an unrelated Stripe Payment Link or manually assign a Stripe subscription as your normal sales process. The current application Checkout establishes the organization/customer/subscription mapping and duplicate-checkout protections. A payment collected elsewhere is not automatically matched just because the email looks the same.

### Configure the Shopify offer

1. In your existing Shopify admin, use a **physical product** for the NFC card, with inventory and shipping appropriate to the stock you actually hold.
2. Keep the confirmed hardware price and shipping charge in Shopify. The hardware price is still an owner decision in this tutorial; no number has been invented.
3. State explicitly on the product page: the physical card is a one-time purchase; the dashboard is a separate recurring subscription at 4,990 Ft/month or 49,900 Ft/year, with the current 14-day no-card software trial.
4. Explain that the card will open a VéleményTap feedback page and that Google reviews are completed separately on Google. Do not advertise automatic posting or Google-review import.
5. Add a clearly labelled link to `https://velemenytap.com/signup` for account creation and `https://velemenytap.com/login` for existing customers. The subscription itself starts inside their account, under **Számlázás**.
6. Use manual fulfilment for cards you program and ship yourself. Review payment status, program/test the correct card, then mark the actual items fulfilled and provide real tracking when available. Do not mark an unprogrammed card shipped merely because a payment was received.
7. Reconcile the Shopify order with the customer's organization and card URLs in your private order record. Do not store passwords there.

Shopify's official [manual fulfilment instructions](https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/single-fulfillment) describe fulfilling individual orders. These instructions are a setup plan; this review has not modified your Shopify store, inventory, theme, shipping prices or products.

### Example: one café buys two cards

- The café orders two physical cards on the .hu shop.
- Its owner signs up on .com and creates the café business.
- Together you create the location and verify that its Google link opens that café.
- Create two digital records: `Pult 01` and `Terasz 01`. Copy their two different public links.
- Write one link to each physical card, then label the packaging so they cannot be swapped.
- Confirm ratings from each appear under the correct card; confirm the alert recipient receives the authorized setup test.
- The café owner purchases the software inside their own billing page. One organization subscription covers its current supported locations/cards; it is not a separate subscription per physical card.
- Record order → organization → location → card name → public URL → tap tested → handed over. Keep payment status and setup status as separate fields.

## 15. Sell what the product actually does

The practical offer is **an easy way for guests to send feedback, plus a dashboard that helps the business notice and handle it**. Lead with a working demonstration, not promised review counts or guaranteed sales.

A short Hungarian explanation you can use:

> A VéleményTap kártyát a vendég a telefonjához érinti, és megnyílik a vállalkozás visszajelzési oldala. A beküldött értékeléseket egy saját irányítópulton látod, helyszín és kártya szerint. Az alacsony értékelésekről e-mailes értesítést állíthatsz be, és követheted, melyik visszajelzéssel foglalkoztál már. A Google-értékelési oldaladat is elérik a vendégek; a Google-on a véleményt ők teszik közzé. A kártya külön vásárolható meg, a szoftver 4 990 Ft havonta vagy 49 900 Ft évente, és 14 napig bankkártya nélkül kipróbálható.

Do not promise that every alert is instant or guaranteed: cooldowns and email delivery apply. Do not describe private feedback as a verified Google review. Do not promise removal or prevention of negative Google reviews, permanent free dashboard access, automatic Shopify provisioning, guest reply messaging, or automatic cancellation-based card locks.

### A five-minute demonstration

1. Show the public URL on your phone. Until you have a real card, say that you are demonstrating the browser experience, not the physical tap.
2. Submit a labelled setup rating on a dedicated demo card. Show it appear in the dashboard.
3. Show feedback status and an internal note, then the analytics page. Explain that notes are internal and do not message the guest.
4. Show the correct Google destination without publishing a fake review.
5. Demonstrate a card lock and unlock on the demo card, never on a real customer's active card just for a sales demonstration.
6. Show the two software prices and explain the separate physical-card charge. Invite the business to try it with one location first.

An honest answer to “why pay monthly?” is: **the subscription pays for the dashboard, feedback management, reporting and ongoing software operation**. The NFC chip alone is a link carrier. The current public link keeps working after software expiry unless a card/location is disabled or you apply an owner lock; do not imply otherwise.

### First-customer process

Use a small assisted pilot with businesses you can personally help. Agree a real support contact and a clear scope before collecting money. After setup, check that the owner can sign in, find a new rating and manage their subscription unaided. Ask what was confusing and improve the setup instructions from those observations. Measure account setup completed, cards tested, feedback received, software activated and support time; do not present these as guaranteed conversion rates.

Google's published policy prohibits discouraging negative reviews or selectively soliciting positive reviews. The currently requested rating-dependent path gives high ratings a more direct Google action; do not market it as Google-approved. An equally visible Google option for every rating is the lower-risk product direction. This review preserves your explicitly requested flow and records the decision rather than silently redesigning it. Sources: [Google policy](https://support.google.com/business/answer/7400114) and [Google review guidance](https://support.google.com/business/answer/3474122?hl=en).

## 16. Finish the first real paid setup

A successful build and automated tests are not a completed real customer purchase. Use one genuine, authorized purchase to complete this checklist; the person paying enters their own payment information and approves the charge.

1. Sign up using the intended customer account on .com, receive the actual email and click its confirmation link.
2. Verify the correct organization and trial, create a location/card and test the saved feedback.
3. Open **Számlázás**, select the intended cadence and confirm the displayed amount before paying. Expected current amounts: 4,990 Ft monthly / 49,900 Ft annually.
4. Complete the purchase yourself. A browser return URL alone is not proof of payment. In Stripe, verify the payment/subscription and the relevant webhook delivery to `https://velemenytap.com/api/webhooks/stripe`.
5. Back in VéleményTap, verify the subscription state and dashboard access. If payment is pending or access has not updated, use **Frissítés a Stripe alapján** and inspect the webhook; do not pay again as a repair.
6. Open the subscription-management portal from **Számlázás**. Verify that billing information and cancellation controls refer to the same subscription. Only cancel if that is the customer's intent; inspect the effective date first. Cancellation and a refund are different actions.
7. Confirm your invoice/receipt procedure with your accountant and supply the documents your business requires. This software currently has no NAV invoice integration. This tutorial makes no determination of your tax obligations.
8. Receive one authorized low-rating alert in the real recipient's mailbox and check its dashboard link. Also complete one actual .com password-reset email journey without sharing its secret link.
9. When hardware is available, write and tap-test it on the intended phones before calling the whole package ready.

Record a date and result for each check. Do not tick a production mailbox test based on a simulated email token, a delivery API acceptance, or an isolated-project test.

## 17. Your daily owner routine

**At each new order:** match the account to the order, prepare the correct card links, test them, confirm the alert recipient and record what was handed over. A customer's Google review destination can be edited in **Helyszínek** without rewriting the card because the card keeps its VéleményTap URL. Moving the card to a different location currently requires a new card record and rewriting its link.

**When a customer needs help:** use `/admin` to find and lock cards. This owner panel does not impersonate the customer or edit all of their settings; for locations, account settings and billing, guide the customer in their own session. Never ask them to send you their password.

**When a card is lost:** identify its business and exact card, enter the reason, apply the owner lock and open its URL to verify the inactive message. A replacement needs its own digital record/link if it should be independently controllable. Keep the old record for history.

**When a customer cancels:** verify the actual subscription status/effective date in Stripe, follow the agreed cancellation/refund procedure, and explain what happens to dashboard access. The public card does not automatically lock. Apply a manual lock only in accordance with the service agreement and the customer's situation; do not treat cancellation as a technical failure.

**Daily:** check failed Stripe webhooks, billing-reconciliation workflow runs, failed application requests and email-delivery failures. Address “charged but no access” before asking anyone to retry payment. For a service outage, distinguish the .hu shop from the .com software and the public card link.

**Before changing domains:** preserve the .com domain and old `/r/` URLs already written to customer cards. Keep domain renewal and account recovery under your control. Do not cancel the domain or remove redirects as part of a storefront redesign.

**Before upgrades:** keep Git history, apply reviewed migrations in the documented order and verify the deployed version. Confirm what database backup/restore option is actually enabled in Supabase and arrange a restore rehearsal in an isolated environment; do not assume a specific plan includes a backup feature you have never checked.

## 18. Ready-to-copy customer handover

Replace bracketed fields before sending. This review has not sent this message to anyone.

> Szia [név]!
>
> Elkészült a VéleményTap beállításod a következő vállalkozáshoz: [vállalkozás / helyszín].
>
> Belépés: https://velemenytap.com/login — a saját, megerősített e-mail címeddel.
>
> Kártyáid: [kártyanevek és darabszám]. A kártyákat teszteltük: [dátum / pontosan mi lett tesztelve].
>
> A beérkező visszajelzéseket a Vélemények menüben találod. Az Elemzés mutatja a belső értékelések alakulását. A Beállításokban az értesítési cím: [cím; megerősítve / még megerősítendő].
>
> Előfizetésedet a Számlázás menüben tudod kezelni. A választott díj: [havi 4 990 Ft / évi 49 900 Ft]. A fizikai kártya külön vásárlás. [Próba lejárata vagy ellenőrzött előfizetési állapot.]
>
> A Google-értékelést a vendég külön, a Google oldalán írja meg. A saját irányítópulton a VéleményTapra beküldött visszajelzések láthatók.
>
> Segítség: [valós támogatási cím / elérhetőség]. Jelszót vagy bankkártyaadatot soha ne küldj üzenetben.

### Final release note for this guide

Updated 21 September 2026. The owner account has been provisioned separately; ordinary customer signups never receive platform-admin access. The review fixes the missing 4–5-star submission fallback without a Google link, stale inactive-form actions, notification failure handling and spreadsheet-formula handling in card exports. See `RELEASE_REVIEW_2026-09-21.md` for the tested scope and unresolved external checks.
