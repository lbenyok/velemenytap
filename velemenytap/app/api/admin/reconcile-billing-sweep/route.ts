import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileOrganizationBilling } from "@/features/billing/reconcile";

/**
 * Found during this round's own independent adversarial audit: a plain
 * `!==` on the bearer secret is not timing-safe (it short-circuits on the
 * first mismatched byte) -- this endpoint is reachable from the public
 * internet (proxy.ts's PUBLIC_PATHS), so its own comparison should not be
 * weaker than the security boundary it's documented as being.
 * timingSafeEqual() throws on a length mismatch rather than returning
 * false, so the length check must happen first -- that comparison alone
 * leaks only the expected secret's fixed length, never any of its
 * content, so it doesn't reintroduce a timing side-channel of its own.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// How many organizations one sweep run may reconcile. Each one costs a
// Stripe list() call, and the workflow runs every 15 minutes, so this
// bounds a single run rather than the backlog -- anything not reached
// stays a candidate and is picked up by the next run, oldest attempt
// first (see the ordering in get_billing_reconciliation_candidates).
const SWEEP_BATCH_LIMIT = 100;

// How long an organization's local billing state may go unverified before
// the sweep re-derives it regardless of whether anything asked. This is
// the trigger that does NOT depend on this app ever having been told
// something changed.
const SWEEP_STALE_SECONDS = 60 * 60;

// R10-08: how long an organization may stay dirty before that stops being
// ordinary contention and becomes an operator-visible failure. Generous
// relative to the 15-minute sweep interval -- four consecutive sweeps must
// have failed to converge it -- so that normal lease contention, a brief
// Stripe outage, or a single slow scan never pages anyone.
const SWEEP_BACKLOG_SECONDS = 60 * 60;

/**
 * Fourth independent review, Finding 5: "a monitored scheduled
 * reconciliation mechanism." Re-derives each candidate organization's
 * entitlement from Stripe via the same shared service every other caller
 * uses. This is the backstop that makes convergence guaranteed rather than
 * merely likely: Stripe's own webhook retries are finite (this app has no
 * control over how many, or for how long), so a permanently missed webhook
 * must not mean a permanently wrong local state.
 *
 * Fifth round, migration 20260908110000: candidate selection moved from a
 * bare `needs_reconciliation = true` filter to
 * get_billing_reconciliation_candidates, which adds two things that filter
 * could not express. First, an unsatisfied generation
 * (billing_sync_requested > billing_sync_completed) is a candidate even if
 * the flag was cleared -- that pair is what stops an event arriving during
 * a reconciliation from being lost. Second, and more importantly, STALENESS
 * is a candidate reason on its own: every path that sets the dirty flag
 * runs inside this application, so an event this app never received at all
 * (a misconfigured endpoint, a delivery dropped after Stripe gave up, a
 * change made by hand in the Stripe Dashboard) would otherwise leave
 * nothing dirty and stay invisible forever. Elapsed time is something this
 * app can always observe without being told.
 *
 * Public (proxy.ts's PUBLIC_PATHS) because its caller -- a scheduled job,
 * not a signed-in user -- has no session. `RECONCILE_SWEEP_SECRET` is the
 * actual security boundary, the same pattern as the Stripe webhook route
 * (whose real boundary is its own signature check, not proxy.ts's auth
 * gate). See DEPLOYMENT.md for how to configure the secret and wire up
 * the scheduled trigger (a GitHub Actions workflow calling this route on
 * a cron schedule) -- provisioning the actual schedule is an owner
 * action, since it needs a repository secret configured; this route and
 * the workflow that calls it are both already committed.
 */
export async function POST(request: NextRequest) {
  const expectedSecret = process.env.RECONCILE_SWEEP_SECRET;
  if (!expectedSecret) {
    console.error("RECONCILE_SWEEP_SECRET is not configured -- refusing to run the reconciliation sweep.");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${expectedSecret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: candidates, error: readError } = await admin.rpc("get_billing_reconciliation_candidates", {
    p_limit: SWEEP_BATCH_LIMIT,
    p_stale_seconds: SWEEP_STALE_SECONDS,
  });

  if (readError) {
    return NextResponse.json({ error: `Failed to list reconciliation candidates: ${readError.message}` }, { status: 500 });
  }

  const results: { organizationId: number; outcome: string }[] = [];
  for (const row of candidates ?? []) {
    if (!row.stripe_customer_id) {
      // The candidate query already excludes these; belt and braces, since
      // reconciling without a customer id is meaningless.
      results.push({ organizationId: row.organization_id, outcome: "skipped_no_customer" });
      continue;
    }
    const result = await reconcileOrganizationBilling(row.organization_id, row.stripe_customer_id);
    results.push({ organizationId: row.organization_id, outcome: result.outcome });
  }

  // R9-06 (round-9 review): this used to return 200 unconditionally, so a run
  // in which Stripe was unreachable and EVERY reconciliation returned `error`
  // still left the scheduled workflow green. `curl -fsS` checks the HTTP
  // status, not the body, so the one signal the monitor actually reads said
  // nothing was wrong. The durable dirty flags meant no work was lost -- but
  // "no work lost" and "the operator has been told" are different guarantees,
  // and only the first was true.
  //
  // `deferred` is deliberately NOT a failure: it means another writer holds
  // the lease, which is normal contention and self-correcting. Only genuine
  // errors are escalated, so this cannot turn ordinary concurrency into a
  // page.
  const errors = results.filter((r) => r.outcome === "error").length;

  // R10-08 (round-10 review): the paragraph above is right that `deferred` is
  // ordinary contention and self-correcting -- and wrong to conclude that
  // EVERY deferred case therefore is. The review demonstrated a perfectly
  // healthy three-page subscription scan outliving its 45-second lease: the
  // write is rejected, the row stays dirty, the sweep reports `deferred`, and
  // every retry with the same latency reproduces it exactly. A paid
  // organization can sit locally canceled with this endpoint returning 200
  // forever.
  //
  // The durable dirty flag guarantees the work is not LOST. It does not tell
  // anyone the work is STUCK, and those are different guarantees -- the same
  // distinction R9-06 drew for errors, one level up. The signal that
  // distinguishes them is not any single run's outcome but how long an
  // organization has been dirty, which is something this app can always
  // observe without being told what went wrong.
  const { data: backlog, error: backlogError } = await admin.rpc("get_billing_reconciliation_backlog", {
    p_older_than_seconds: SWEEP_BACKLOG_SECONDS,
    p_limit: SWEEP_BATCH_LIMIT,
  });
  if (backlogError) {
    console.error(`Reconciliation sweep: failed to read the backlog: ${backlogError.message}`);
    return NextResponse.json(
      { swept: results.length, errors, results, error: `Failed to read the reconciliation backlog: ${backlogError.message}` },
      { status: 500 },
    );
  }

  const stuck = backlog ?? [];
  if (stuck.length > 0) {
    console.error(
      `Reconciliation sweep: ${stuck.length} organization(s) have been awaiting reconciliation for over ` +
        `${SWEEP_BACKLOG_SECONDS}s and are not converging on their own -- ` +
        stuck
          .map((o) => `org ${o.organization_id} (${o.dirty_seconds}s${o.last_error ? `, last error: ${o.last_error}` : ""})`)
          .join("; ") +
        ". See OPERATOR_RECOVERY.md § 3.",
    );
  }

  if (errors > 0) {
    console.error(`Reconciliation sweep: ${errors} of ${results.length} organizations failed to reconcile.`);
  }

  if (errors > 0 || stuck.length > 0) {
    return NextResponse.json({ swept: results.length, errors, backlog: stuck, results }, { status: 500 });
  }

  return NextResponse.json({ swept: results.length, errors: 0, backlog: [], results });
}
