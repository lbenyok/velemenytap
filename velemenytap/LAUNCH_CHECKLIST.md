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

Signup confirmation and password reset go through **Supabase Auth's own mailer**, not
this app's Resend integration. They are different paths; the verified `velemenytap.hu`
Resend domain does nothing for them until it is configured as Auth's SMTP provider.

Measured against the isolated project: `resend` and `resetPasswordForEmail` were
**accepted with no error while nothing arrived** at a real external mailbox, and
`signUp` hit the project-wide hourly cap. That is the built-in mailer, which delivers
only to project team members.

- [ ] **[you]** Authenticate the Supabase CLI so the configuration can be read:
      `supabase login` (browser), or `supabase login --token <PAT>` with a token from
      <https://supabase.com/dashboard/account/tokens>.
- [ ] **[me]** Read the isolated **and** production Auth settings and report what is
      actually configured, rather than inferring it from behaviour.
- [ ] **[me]** Configure SMTP on the **isolated** project first and verify it by
      receiving and clicking real signup, resend and password-reset emails.
- [ ] **[you]** Apply the same configuration to **production** once the isolated run is
      green. Sender address must be on a domain you control and have verified.
- [ ] **[you]** Decide the sender identity customers will see (e.g.
      `no-reply@velemenytap.hu` vs a monitored address).

## 2. Stripe live configuration

Test mode is fully verified end to end (initial purchase, annual, renewal, failed
payment, recovery, cancellation, resubscription). Live mode shares none of that
configuration.

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

- [ ] **[you]** Confirm production is still on migration 17 (`supabase migration list`)
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

1. `supabase login` — unblocks the whole email investigation.
2. Stripe live Product, Prices, webhook endpoint, and the env vars for them.
3. Three sweep secrets/variables, set together.
4. Confirming production's migration state, then running the two rollout commands.
5. One real live-mode transaction and one real password-reset click.
6. Everything in `BUSINESS_DECISIONS.md` — none of which is an engineering question.
