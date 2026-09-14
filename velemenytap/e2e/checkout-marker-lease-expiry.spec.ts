import { test, expect } from "@playwright/test";
import { connectToTestDb } from "./support/db-connection";
import { seedOrgWithMember, cleanupOrgWithMember, type SeededOrgMember } from "./support/seed";

/**
 * Round-14 R14-03: the clock-before-lock class, seventh instance, and this one
 * was introduced by round 12's own fix.
 *
 * `mark_checkout_request_sent` was a single `UPDATE ... WHERE ... and
 * checkout_attempt_expires_at > clock_timestamp()`. The qualification is
 * evaluated during the scan -- BEFORE the statement waits for a row lock
 * somebody else holds. PostgreSQL re-checks it after the wait only when the
 * tuple was actually updated (EvalPlanQual follows `t_ctid`); a holder that
 * merely took `SELECT ... FOR UPDATE` without writing leaves the tuple version
 * unchanged, so the pre-wait clock reading stands.
 *
 * Why it matters here rather than being a curiosity: the application reads
 * `true` from this function as authorization to go and create a Checkout
 * Session at Stripe, and the lease is what is supposed to guarantee no other
 * worker is about to do the same. So the last check before a payable Session
 * could pass on a lease that had already run out while it waited.
 *
 * Needs two real, independently-connected Postgres clients -- a single
 * connection cannot hold a lock against itself, and a mocked one proves
 * nothing about EvalPlanQual.
 */

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("checkout-marker-lease");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("the marker refuses a lease that expired while it waited on a plain row lock", async () => {
  const holder = await connectToTestDb(); // takes SELECT ... FOR UPDATE and sits on it
  const marker = await connectToTestDb(); // calls mark_checkout_request_sent
  test.skip(!holder || !marker, "No direct Postgres connection available in this environment.");
  if (!holder || !marker) return;

  const attemptId = `attempt-${Date.now()}`;
  const ownerToken = `owner-${Date.now()}`;

  try {
    // Seeded through the database connection, with the deadline expressed in
    // the DATABASE's own clock. Computing it from Date.now() locally made this
    // test depend on the two clocks agreeing -- and this project has measured
    // real skew against this project before (the PGRST303 "JWT issued at
    // future" flake). The function compares against clock_timestamp(), so the
    // fixture has to speak the same clock or the test proves nothing.
    await marker.query(
      `insert into public.organization_billing
         (organization_id, checkout_attempt_id, checkout_owner_token,
          checkout_attempt_expires_at, checkout_request_state)
       values ($1, $2, $3, clock_timestamp() + interval '1 second', 'unused')
       on conflict (organization_id) do update set
         checkout_attempt_id = excluded.checkout_attempt_id,
         checkout_owner_token = excluded.checkout_owner_token,
         checkout_attempt_expires_at = excluded.checkout_attempt_expires_at,
         checkout_request_state = excluded.checkout_request_state`,
      [member.orgId, attemptId, ownerToken],
    );

    // The holder takes a PLAIN row lock: it reads and does not write, which is
    // exactly the shape that suppresses the post-wait re-check.
    await holder.query("begin");
    await holder.query("select * from public.organization_billing where organization_id = $1 for update", [
      member.orgId,
    ]);

    const markerCall = marker.query(
      "select public.mark_checkout_request_sent($1, $2, $3) as marked",
      [member.orgId, attemptId, ownerToken],
    );

    // Confirm it is genuinely blocked on the lock rather than having already
    // returned -- otherwise this test would pass without reproducing anything.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { rows: waiting } = await holder.query(
      "select count(*)::int as blocked from pg_stat_activity where wait_event_type = 'Lock' and query like '%mark_checkout_request_sent%'",
    );
    expect(waiting[0].blocked, "the marker was not actually waiting on the lock").toBeGreaterThan(0);

    // Let the lease die, then release.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await holder.query("commit");

    const { rows } = await markerCall;
    expect(rows[0].marked, "the marker accepted an already-expired lease").toBe(false);

    // And the state was not advanced, which is the consequence that matters:
    // `sent` is what stops a later attempt from being discarded, so writing it
    // on a dead lease corrupts the very bookkeeping R12-01 introduced.
    const { rows: state } = await marker.query(
      "select checkout_request_state from public.organization_billing where organization_id = $1",
      [member.orgId],
    );
    expect(state[0].checkout_request_state).toBe("unused");
  } finally {
    await holder?.query("rollback").catch(() => {});
    await holder?.end().catch(() => {});
    await marker?.end().catch(() => {});
  }
});

test("the marker still succeeds on a live lease held by nobody", async () => {
  const marker = await connectToTestDb();
  test.skip(!marker, "No direct Postgres connection available in this environment.");
  if (!marker) return;

  const attemptId = `attempt-ok-${Date.now()}`;
  const ownerToken = `owner-ok-${Date.now()}`;
  try {
    await marker.query(
      `insert into public.organization_billing
         (organization_id, checkout_attempt_id, checkout_owner_token,
          checkout_attempt_expires_at, checkout_request_state)
       values ($1, $2, $3, clock_timestamp() + interval '2 minutes', 'unused')
       on conflict (organization_id) do update set
         checkout_attempt_id = excluded.checkout_attempt_id,
         checkout_owner_token = excluded.checkout_owner_token,
         checkout_attempt_expires_at = excluded.checkout_attempt_expires_at,
         checkout_request_state = excluded.checkout_request_state`,
      [member.orgId, attemptId, ownerToken],
    );

    const { rows } = await marker.query(
      "select public.mark_checkout_request_sent($1, $2, $3) as marked",
      [member.orgId, attemptId, ownerToken],
    );
    // Without this the fix could be "always return false" and the test above
    // would still pass.
    expect(rows[0].marked).toBe(true);
  } finally {
    await marker?.end().catch(() => {});
  }
});
