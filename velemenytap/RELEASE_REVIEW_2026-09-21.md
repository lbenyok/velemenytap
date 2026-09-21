# VéleményTap release review — 21 September 2026

## Verdict

The implemented product can support an **assisted customer pilot**, subject to completing the real payment, mailbox and physical-card checks below. It is not yet a fully automated Shopify-to-software sales system. Selling cards together with the SaaS currently requires manual account/card mapping and fulfilment. Do not treat this review as proof that no bugs remain or that external business arrangements are complete.

The primary practical blocker is now proving one complete real customer journey and finishing the commercial information, rather than another general rewrite. The owner panel exists at https://velemenytap.com/admin and the confirmed owner account has been granted access. Customers cannot self-grant that role.

## Review scope

Reviewed public feedback and Google routing; tenant-scoped organization/location/card operations; the owner lock/access model; signup/recovery guards; alert recipient resolution and failure handling; billing entitlement and checkout-result handling; CSV exports; owner instructions and launch evidence. Ran the full existing browser/database suite against the isolated Supabase project, including billing races, aggregation, public submission, permissions, tenant isolation, recovery and onboarding. Existing Stripe logic is extensively exercised by unit tests and database concurrency tests; those are not real live Stripe purchases.

Production observation: the Supabase Site URL is https://velemenytap.com, confirmation/callback return URLs are configured, email confirmation is enabled, secure email change is enabled, and “Require current password when updating” is enabled. These are read-only observations. No credentials or live customer payment details were printed.

## Fixes in this release

| Issue | Impact | Repair and evidence |
| --- | --- | --- |
| 4–5-star feedback had no submit action when no Google URL was configured | Positive feedback could not reach the business during incomplete setup | Added the internal submission fallback; real browser/database tests prove both 4 and 5 are saved without a Google link |
| A stale form rejected as inactive could show a Google action again after changing to 4–5 stars | The interface contradicted the confirmed inactive state | Hide that action after an inactive response; regression switches from 3 to 5 after rejection and verifies no action reappears |
| Failed notification-setting read fell back to organization members | Could use recipients other than the configured override when the lookup failed | Stop safely on failed/missing organization lookup and failed membership lookup; require confirmed member email for fallback |
| An exception while finalizing the alert log escaped the handler | A background bookkeeping failure could reject a supposedly non-throwing alert task | Catch transport failures in finalization; tests cover accepted and failed sends and prove no rejection escapes |
| User-controlled CSV names could be interpreted as formulas | Opening exported card inventories in a spreadsheet could evaluate attacker-supplied formulas | Prefix formula-like names as text while preserving delimiter, quotes, Hungarian characters and public links; six new regression cases |
| Billing return messages claimed no charge had occurred | A cancel URL or not-yet-paid observation is not proof no charge exists or will complete | Use truthful unconfirmed-status wording and advise refreshing/checking before starting another payment |
| New owner-lock RPC missing from the exhaustive permissions test | Full suite failed and the new RPC was not in the catalog coverage assertion | Add the RPC with service-role-only expectations and verify actual anonymous/authenticated/service privileges against PostgreSQL |

The stale-form repair cannot close a Google tab already opened before the server learns a card was locked. The public submission still performs its atomic card/location check, and no rejected feedback is inserted. A remote lock controls the VéleményTap link; it cannot disable the chip or the public Google listing.

## Test evidence

- Full unit suite after final fixes: **672/672 passed**.
- Full browser/database run: **234 passed, 1 failed**, no skipped checks. The failure was the missing owner-lock entry in the exhaustive RPC manifest, not an observed permission bypass.
- After the manifest fix: **56/56 targeted browser/database checks passed**, including the actual owner-lock privilege matrix, exhaustive function coverage, public safety regressions and all existing rating-flow checks.
- An intervening targeted attempt could not connect because the resumed tool session had network access denied (`EACCES`). That attempt was not counted as evidence; after restoring network access the same target suite passed.
- Isolated-project password protection check: direct password update without the current password was refused, and the attempted replacement password did not work. The script deleted its throwaway account.
- Production password setting: observed enabled in Supabase. This review did not run a separate production password-change attack test.
- Changed-file lint, TypeScript checking and the optimized production build all passed. No new database migration is needed by these fixes; production remains on 52 migrations.

This is a full run plus a targeted repair verification, **not** a claim that a second complete 236-test run was performed. Only relevant checks were repeated after changes.

## Remaining external checks and product limits

1. **Live payment:** the current live setup still needs a purchaser-completed checkout, observed successful webhook, correct dashboard activation and portal verification. No charge, cancellation or refund was made during this review. The local Stripe key is test-mode; its presence cannot validate Vercel's live key.
2. **Real production emails on .com:** complete an actual signup confirmation and password-reset link click, then one authorized below-four-star alert received by the intended recipient. Earlier reported deliveries and simulated recovery tokens are not new mailbox evidence.
3. **Physical card:** no card was available. Browser tests prove URL behavior, not chip writing, phone antenna placement or device compatibility.
4. **Commercial setup:** hardware price, real support contact, business identity, terms/privacy content and invoicing procedure remain owner/accountant inputs. No invented values or legal conclusions have been inserted.
5. **Sales automation:** no Shopify purchase webhook provisions a software account or card. No customer impersonation, staff invitation flow, Google-review import, automatic refund or NAV invoice integration is provided. The tutorial documents manual fulfilment.
6. **Scale:** the customer card/location selectors and CSV currently load unpaginated Supabase lists, so their completeness beyond the service's configured row limit is not established. The owner panel itself is paginated. Do not promise tested unlimited-size inventories; a high-volume customer needs a separate pagination/load check before onboarding.
7. **Google policy:** Google prohibits discouraging negative reviews or selectively soliciting positive reviews. The requested rating-dependent routing gives high ratings a more direct Google path. It has been preserved as an explicit product choice, not certified as compliant. Do not sell it as Google-approved or promise negative-review suppression. [Official Google policy](https://support.google.com/business/answer/7400114).
8. **Delivery and operations:** email cooldowns/rate budgets remain; no guaranteed instant delivery or automatic retry digest has been added. Confirm the backup/restore arrangement and monitor webhook/sweep/mail failures during the pilot.

## Owner deliverables

`OWNER_GUIDE.md` is the complete operating and sales tutorial: 18 sections with software and physical-card setup, Shopify/Stripe boundaries, a two-card example, an honest Hungarian sales explanation, first paid setup checklist, troubleshooting and a customer handover template. `PLATFORM_ADMIN.md` describes the owner panel's security and lock semantics. The tutorial is also supplied as a printable HTML file for easier reading outside the repository.
