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

/**
 * Fourth independent review, Finding 5: "a monitored scheduled
 * reconciliation mechanism." Scans every organization currently marked
 * needs_reconciliation (set durably by the reconciliation-lease database
 * functions themselves whenever a webhook or another reconciliation
 * attempt couldn't complete -- migration 20260907210000) and re-derives
 * each one's entitlement from Stripe via the same shared service every
 * other caller uses. This is the backstop that makes convergence
 * guaranteed rather than merely likely: Stripe's own webhook retries are
 * finite (this app has no control over how many, or for how long), so a
 * permanently missed webhook must not mean a permanently wrong local
 * state.
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
  const { data: dirty, error: readError } = await admin
    .from("organization_billing")
    .select("organization_id, stripe_customer_id")
    .eq("needs_reconciliation", true)
    .limit(200);

  if (readError) {
    return NextResponse.json({ error: `Failed to list organizations needing reconciliation: ${readError.message}` }, { status: 500 });
  }

  const results: { organizationId: number; outcome: string }[] = [];
  for (const row of dirty ?? []) {
    if (!row.stripe_customer_id) {
      results.push({ organizationId: row.organization_id, outcome: "skipped_no_customer" });
      continue;
    }
    const result = await reconcileOrganizationBilling(row.organization_id, row.stripe_customer_id);
    results.push({ organizationId: row.organization_id, outcome: result.outcome });
  }

  return NextResponse.json({ swept: results.length, results });
}
