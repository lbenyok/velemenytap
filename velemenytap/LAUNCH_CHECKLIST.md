# Launch checklist

One page, in order. These checks concern external configuration. Some are complete;
use the dated evidence in STATUS.md rather than assuming all are still pending.
`DEPLOYMENT.md` holds the full reasoning for each step.

Legend: **[you]** needs your account access or a decision only you can make ·
**[me]** I can do it once the prerequisite exists · **[auto]** already automated.

2026-09-19: production reports a build expecting all 51 migrations through
20260914120000; the old migration-17 statement was obsolete. The .com domain and
Supabase Site URL/return paths are configured. Live Stripe variables remain absent
from Vercel, and a new-domain real email round trip and real purchase are still open.

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
- [x] **[you]** Apply **both** fixes to production. **Done 2026-09-11** — proven by
      the end-to-end verification recorded below: a real signup email arrived from
      `no-reply@velemenytap.hu` (so SMTP is live) carrying the `token_hash` shape
      (so the template was replaced). SMTP settings used:

      host smtp.resend.com · port 465 · user `resend` · pass = your Resend API key
      sender: an address on the verified `velemenytap.hu` domain

- [x] **[you]** Replace the production **Confirm signup** template link with — **done**,
      verified by clicking a real one:

      {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding

- [x] **[you]** Replace the production **Reset password** template link with — **done**;
      the link authenticates correctly and then 404s only because the ROUTE ships
      with this branch, which is itself the evidence the template was replaced:

      {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password

- [ ] **[you]** Enable **"Require current password when changing password"**
      (Authentication → Providers → Email) on **production and the isolated test
      project**. Round-15 R15-01: without it, an ordinary signed-in session can
      change its own password through the Auth API directly, bypassing every
      application-side guard — measured, not assumed, on 2026-09-14. The app
      already forwards `current_password`, so enabling it does not break
      ordinary changes, and recovery sessions are exempt by design.
      **"Secure password change" is a DIFFERENT option and is not enough**: it
      exempts sessions created in the last 24 hours, which is exactly the
      unattended-browser session this is about.
- [ ] **[me]** Re-run `node scripts/check-password-change-enforcement.mjs`
      against each project after you enable it. It creates and deletes one
      throwaway user and exits non-zero while the bypass still works, so this
      gate is measured rather than ticked.
- [ ] **[you]** Raise the hourly email rate limit from 2 (it exists to protect the
      built-in mailer and is far too low once real SMTP is in place).
- [ ] **[you]** **The Vercel project was renamed on 2026-09-14**, so Supabase Auth's
      `site_url` almost certainly still points at the old `veleminytap.vercel.app`.
      `{{ .SiteURL }}` in both email templates resolves to whatever that setting says,
      so every confirmation and recovery link is being generated against the old host
      until you change it. Set it to `https://velemenytap.vercel.app`, and add the
      matching entry to the **redirect allowlist** (`https://velemenytap.vercel.app/auth/confirm**`)
      while leaving the old entry in place during changeover. Then send yourself one real
      signup email and click it. Original note: `{{ .SiteURL }}` in the templates above resolves to exactly this,
      so if the Vercel project is ever renamed, both move together.
- [x] **[you]** Decide the customer-visible sender identity. **Settled in practice:**
      production sends from `no-reply@velemenytap.hu`, observed in the verified
      signup email. Change it if you prefer, but nothing is blocked on it.
      Original note: The isolated project uses
      `alerts@velemenytap.hu` because it was already proven; an account-email address
      such as `no-reply@` may read better, and any local part on the verified domain
      works.

**Production signup confirmation is now VERIFIED end to end** (2026-09-11). A real
signup to a real external mailbox, the email received from
`no-reply@velemenytap.hu`, the link clicked: it carries the `token_hash` shape and
lands on **`/onboarding`**, and the account is genuinely confirmed in production
Auth (`email_confirmed_at` set). Both faults are closed for the flow every new
customer actually hits. The throwaway account was deleted afterwards.

**Password reset is a DIFFERENT matter, and the recovery template alone cannot fix
it.** Verified the same way, the reset email arrives and its link authenticates
correctly (a real `sb-` session cookie is set) — and then lands on **HTTP 404**,
because `/auth/reset-password` **does not exist in the deployed production code**.
Nor does `/auth/forgot-password`, and master's login page has no "forgot
password" link at all. Self-service password reset is a feature of this branch,
not of what is deployed:

| Route | master (production) | this branch |
|---|---|---|
| `/auth/confirm` | yes | yes |
| `/auth/auth-code-error` | yes | yes |
| `/auth/reset-password` | **no — 404** | yes |
| `/auth/forgot-password` | **no** | yes |
| password change in settings | **no** | — |

So today no customer can even *request* a reset: there is no entry point. The
recovery template is pointed at the page that ships **with this branch**, where
the identical flow was already verified end to end against the isolated project.
It is correct for the code about to ship and inert for the code running now.
Deliberately left that way — repointing it at `{{ .ConfirmationURL }}` would
restore the fragment bug, and repointing it at `/dashboard` would log a user in
with still no way to change their password, and would need undoing at deploy.

**Round 13 called this a P1 launch blocker; I disagree, and the disagreement is
recorded rather than settled.** The 404 is real. What is disputed is reachability:
`master` has no `/auth/forgot-password` route and its login form renders no reset
link, so there is no customer-reachable way to trigger a recovery email at all --
the only way to send one is a deliberate API call, which is what the verification
test did. Self-service reset is a feature that ships with this branch, where both
routes exist and the flow was verified end to end against the isolated project.

The alternatives are worse: `{{ .ConfirmationURL }}` reinstates the URL-fragment
bug this branch exists to fix, and `/dashboard` logs a user in with no
password-change UI on master at all -- and both would need undoing at deploy,
adding a must-remember step whose omission breaks recovery **permanently** rather
than temporarily. The gate below is the mitigation.
- [ ] **[you]** After the branch deploys, click one real password-reset email in
      production and confirm it lands on `/auth/reset-password`. Until then that
      flow is **not available to customers**, which is a missing feature rather
      than a broken one.

## 2. Stripe live configuration

Test mode was verified end to end (initial purchase, annual, renewal, failed
payment, recovery, cancellation, resubscription) — **but before the round-10
billing changes.** It has not been re-run since. Live mode shares none of that
configuration either way.

- [x] **[me]** Isolated Playwright suite and Stripe test-mode lifecycle re-run
      against the round-12 changes once the isolated project recovered:
      **192/192** browser (zero skipped) and **16/16** lifecycle phases. The
      browser run caught a privilege-matrix omission the local harness could
      not — see `STATUS.md`.
- [x] **[me]** Isolated Playwright suite re-run against the round-10
      implementation: **190/190, zero skipped.** It caught a regression the
      unit tests and the PostgreSQL harness both missed — see `STATUS.md`.
- [x] **[me]** Stripe **test-mode lifecycle re-run** against the round-10
      implementation: **16/16 phases**, real test clock, real invoices. Includes
      new assertions that activation carries its verifying invoice and that
      three later payments never re-dated the latch. See `STATUS.md`.
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

## 4. Merge-time Vercel setting (do this in the same window as the merge)

`master` holds the app in `veleminytap/`; this branch renames it to
`velemenytap/`. Vercel's **Root Directory** must match whichever branch is
building, so it is the one project setting that has to change at a specific
moment rather than once, up front. Get it wrong and the build fails immediately
with `Couldn't find any pages or app directory` — loud, but it means production
is not rebuilding.

- [x] **[you]** ~~Confirm the current value in Settings → General → Build and
      Deployment.~~ **Done 2026-09-14.**
- [x] **[you]** Change it to `velemenytap` **as part of merging this branch**.
      **Done 2026-09-14**, immediately before the push — the merge deletes the old
      `veleminytap/` path, so leaving it would have failed the build outright.
- [ ] **[you]** While you are there, confirm the Vercel **project name** and the
      host it serves. `https://velemenytap.vercel.app` serves production today (the
      rename happened on 2026-09-14; the old host now 307-redirects to it) and
      `https://velemenytap.vercel.app` returns 404 (measured 2026-09-12), so the
      project appears **not** to have been renamed — despite commit `08f765f`'s
      message saying it was. The two workflow fallbacks, `scripts/rollout-environments.json`
      and `README.md` now point at `velemenytap.vercel.app`, updated when the project
      was renamed. The old host only 307-redirects, and `curl -fsS` does **not** follow
      redirects — so leaving them on the old spelling would have failed CI's production
      verification and the billing sweep.
- [ ] **[you]** If you do rename the project, Auth's `site_url` and the two workflow
      fallbacks move with it — see § 1's `site_url` item.

## 5. Migration ordering

All of `20260907150000` … `20260908120000` go in the **`--expand`** phase. The exact
command and manifest are in `DEPLOYMENT.md` § 7; do not retype the list from memory.

- [x] **[you]** ~~Confirm production is still on migration 17~~ **Done 2026-09-14** — it was; all 51 are now applied. (`supabase migration list`) — there are now **51** migrations, so 18→51 are the pending set — **31 expand + 3 enforce**, and the enforce list ENDS with `20260914120000_restore_locked_confirm_notification_email_change.sql` for a reason (round-14 R14-02: without it the staged order leaves an older definition of `confirm_notification_email_change` installed than a sorted replay does), and re-derive both lists from `supabase migration list` immediately before the run rather than from any prose
      before starting. **The safety argument depends on it.** Several of these
      migrations change function signatures, which is normally exactly what needs an
      expand/enforce split — it is safe here *only* because none of them has ever been
      deployed, so there is no old caller to keep working. That reasoning expires the
      moment any one of them ships.
- [x] **[you]** Run `prepare` (`--expand`), deploy the application, let old instances
      drain, then run `finalize` (`--enforce`). **Done 2026-09-14**, in that order.
- [x] **[me]** Re-verify the manifest against the migrations directory immediately
      before the run. **Done 2026-09-14** — 34 pending, manifest matched exactly.

## 6. Post-deployment checks

- [x] **[me]** `/api/health` reports the expected latest migration and commit. **Done 2026-09-14** — `200`, `ok:true`, `environment:production`, `c93d84f`. It is
      reachable unauthenticated only from this branch onward — on `master` it answers
      `307 -> /login`, which is why CI's `verify-production-deployment` job could not
      succeed. `e2e/public-route-reachability.spec.ts` is the regression guard.
- [ ] **[you]** One real **live-mode** transaction, start to finish, with a real card:
      subscribe → dashboard unlocks → Billing Portal opens → cancel. No live-mode
      transaction has ever been made.
- [ ] **[you]** Confirm the webhook endpoint shows deliveries succeeding in the Stripe
      dashboard.
- [ ] **[you]** Click a real password-reset email end to end in production. It must land
      on `/auth/reset-password`, **not** `/auth/auth-code-error`.
- [ ] **[me]** Public feedback flow still works unauthenticated for all five ratings —
      the product's one non-negotiable invariant, and the thing most worth re-checking
      after a billing deploy. **Still open on PRODUCTION specifically**: verified by
      `e2e/review-gating.spec.ts` against the isolated project on identical code, and
      `/r/{id}` is confirmed reachable unauthenticated in production — but no real
      production card has been rated 1-5 by hand. Needs one real card to close.
- [x] **[me]** Confirm the paywall gates only the dashboard and never `/r/{publicId}`. **Done 2026-09-14** — `/r/{id}` `200` unauthenticated, `/dashboard` `307` to `/login`.

---

## What needs you, condensed

1. **Enable "Require current password when changing password"** on production and the isolated project — without it the password guard is a UI-path defence only (round-15 R15-01, measured; run `node scripts/check-password-change-enforcement.mjs` to see the current answer). The two email fixes are **already applied and verified** (2026-09-11).
2. Stripe live Product, Prices, webhook endpoint, and the env vars for them.
3. Three sweep secrets/variables, set together.
4. Changing Vercel's **Root Directory** to `velemenytap` in the same window as the merge — the repo subdirectory is renamed on this branch, and the build fails immediately if the two disagree.
5. Confirming production's migration state, then running the two rollout commands.
6. One real live-mode transaction and one real password-reset click.
7. Everything in `BUSINESS_DECISIONS.md` — none of which is an engineering question.
