# Launch checklist

One page, in order. Everything here is **external configuration** — none of it can be
done from this repository, and none of it is done yet. `DEPLOYMENT.md` holds the full
reasoning for each step; this file is the short version plus who has to do it.

Legend: **[you]** needs your account access or a decision only you can make ·
**[me]** I can do it once the prerequisite exists · **[auto]** already automated.

Production currently runs **migration 17 with no Stripe environment variables**. Nothing
below has been applied to it.

---

## 1. Supabase Auth email (do this first — it gates everything else)

This turned out to be **two independent faults**, and fixing only the first would
have looked like progress while leaving every link broken.

**Fault A — no SMTP.** Both projects were on Supabase's built-in mailer, capped at
**2 emails/hour** and documented as delivering only to project team members. Real
sends to an ordinary external mailbox were *accepted with no error* and simply never
arrived.

**Fault B — the email templates.** Both projects' confirmation and recovery templates
use `{{ .ConfirmationURL }}`. That produces a link through `/auth/v1/verify`, which
after verifying redirects to the app with the session in a **URL fragment**. A
fragment is never sent to the server, so a server-rendered route cannot read it — and
every link dead-ended on `/auth/auth-code-error`, *even though the token itself was
consumed correctly*. This app was built for the other flow: `/auth/confirm` has always
read `token_hash` + `type` and called `verifyOtp`. The templates simply never matched
the app written for them.

Both are fixed and **verified end to end on the isolated project**: real emails
received in a real mailbox and clicked — signup confirmation → `/onboarding`, resend →
`/onboarding`, password reset → `/auth/reset-password` with a real session cookie.

- [x] **[me]** Isolated project: SMTP configured (Resend bridge) and templates
      switched to the `token_hash` form. Verified by receiving and clicking all three.
- [ ] **[you]** Apply **both** fixes to production. SMTP settings:

      host smtp.resend.com · port 465 · user `resend` · pass = your Resend API key
      sender: an address on the verified `velemenytap.hu` domain

- [ ] **[you]** Replace the production **Confirm signup** template link with:

      {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding

- [ ] **[you]** Replace the production **Reset password** template link with:

      {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password

- [ ] **[you]** Raise the hourly email rate limit from 2 (it exists to protect the
      built-in mailer and is far too low once real SMTP is in place).
- [ ] **[you]** Confirm production's Auth `site_url` still matches the address that
      actually serves — it is currently `https://veleminytap.vercel.app`, which is
      correct today. `{{ .SiteURL }}` in the templates above resolves to exactly this,
      so if the Vercel project is ever renamed, both move together.
- [ ] **[you]** Decide the customer-visible sender identity. The isolated project uses
      `alerts@velemenytap.hu` because it was already proven; an account-email address
      such as `no-reply@` may read better, and any local part on the verified domain
      works.

**Verify production the same way it was verified here:** sign up with a real address,
click the emailed link, and confirm it lands on `/onboarding` rather than
`/auth/auth-code-error`. An email that *arrives* proves only Fault A is fixed.

## 2. Stripe live configuration

Test mode was verified end to end (initial purchase, annual, renewal, failed
payment, recovery, cancellation, resubscription) — **but before the round-10
billing changes.** It has not been re-run since. Live mode shares none of that
configuration either way.

- [x] **[me]** Isolated Playwright suite re-run against the round-10
      implementation: **190/190, zero skipped.** It caught a regression the
      unit tests and the PostgreSQL harness both missed — see `STATUS.md`.
- [ ] **[me]** Re-run the **Stripe test-mode lifecycle** (annual, renewal,
      failed payment, recovery, cancellation, resubscription) against the
      round-10 implementation. Still the largest outstanding verification gap:
      the activation path changed shape, and only real Stripe events exercise
      it end to end.
- [ ] **[you]** Confirm the live account's **payment method settings**. The app
      sends no `payment_method_types`, which is how Stripe enables
      Dashboard-managed dynamic payment methods — so which methods customers
      actually see is an account setting, not something this repository can
      establish. The round-10 review was right to reject "this app is card only"
      as a source-level claim. Delayed-notification methods change how long a
      payment stays unresolved after Checkout completes.

- [ ] **[you]** Create the live-mode Product and two Prices. They must be **HUF**,
      `recurring`, `interval_count: 1`, and `unit_amount` in fillér — `599000` and
      `5990000`. A mismatch fails closed rather than charging the wrong amount.
- [ ] **[you]** Set the live Vercel env vars: `STRIPE_SECRET_KEY`,
      `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY`.
- [ ] **[you]** Add the production webhook endpoint in Stripe pointing at
      `https://<production host>/api/webhooks/stripe`, and set its signing secret as
      `STRIPE_WEBHOOK_SECRET`.
- [ ] **[you]** Confirm `APP_ENV=production` is set. The livemode guard fails closed if
      it cannot resolve, which is deliberate — see `DEPLOYMENT.md` § 3.
- [ ] **[you]** Enable the Billing Portal in the live dashboard (the "manage
      subscription" button 404s otherwise).

## 3. Reconciliation scheduler and secrets

Not optional. A webhook whose reconciliation defers returns HTTP 500 so Stripe
redelivers it, with the durable dirty flag and the scheduled sweep as the guarantee
underneath. With the secret unset the endpoint answers **503** and that backstop does
not exist — and a renewal burst has no customer page load to self-heal it, because
renewals involve no customer visit.

- [ ] **[you]** `RECONCILE_SWEEP_SECRET` as a Vercel production env var.
- [ ] **[you]** The **same** value as a GitHub Actions repository secret of the same name.
- [ ] **[you]** `PRODUCTION_RECONCILE_SWEEP_URL` as a GitHub Actions variable.
- [x] **[auto]** The 15-minute schedule itself — `.github/workflows/reconcile-billing-sweep.yml`.
- [ ] **[you]** Verify one run returns **200**, not 503, after deploying.

## 4. Migration ordering

All of `20260907150000` … `20260908120000` go in the **`--expand`** phase. The exact
command and manifest are in `DEPLOYMENT.md` § 7; do not retype the list from memory.

- [ ] **[you]** Confirm production is still on migration 17 (`supabase migration list`) — there are now **44** migrations, so 18→44 all go in the expand phase
      before starting. **The safety argument depends on it.** Several of these
      migrations change function signatures, which is normally exactly what needs an
      expand/enforce split — it is safe here *only* because none of them has ever been
      deployed, so there is no old caller to keep working. That reasoning expires the
      moment any one of them ships.
- [ ] **[you]** Run `prepare` (`--expand`), deploy the application, let old instances
      drain, then run `finalize` (`--enforce`). They are deliberately separate commands
      run at different times.
- [ ] **[me]** Re-verify the manifest against the migrations directory immediately
      before the run — it goes stale the moment another migration lands.

## 5. Post-deployment checks

- [ ] **[me]** `/api/health` reports the expected latest migration and commit.
- [ ] **[you]** One real **live-mode** transaction, start to finish, with a real card:
      subscribe → dashboard unlocks → Billing Portal opens → cancel. No live-mode
      transaction has ever been made.
- [ ] **[you]** Confirm the webhook endpoint shows deliveries succeeding in the Stripe
      dashboard.
- [ ] **[you]** Click a real password-reset email end to end in production. It must land
      on `/auth/reset-password`, **not** `/auth/auth-code-error`.
- [ ] **[me]** Public feedback flow still works unauthenticated for all five ratings —
      the product's one non-negotiable invariant, and the thing most worth re-checking
      after a billing deploy.
- [ ] **[me]** Confirm the paywall gates only the dashboard and never `/r/{publicId}`.

---

## What needs you, condensed

1. Apply **both** email fixes to production — SMTP *and* the two templates. Fixing only SMTP produces emails that arrive and links that still dead-end.
2. Stripe live Product, Prices, webhook endpoint, and the env vars for them.
3. Three sweep secrets/variables, set together.
4. Confirming production's migration state, then running the two rollout commands.
5. One real live-mode transaction and one real password-reset click.
6. Everything in `BUSINESS_DECISIONS.md` — none of which is an engineering question.
