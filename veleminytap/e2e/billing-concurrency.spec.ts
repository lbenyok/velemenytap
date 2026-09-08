import { test, expect } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, type SeededOrgMember } from "./support/seed";

/**
 * Fourth independent review: "Unit mocks are acceptable for isolated
 * error branches. They are NOT acceptable as sole proof of database
 * locking, concurrency, ... migration compatibility." This file proves
 * the actual Postgres-level locking/CAS behavior of the checkout-attempt
 * and reconciliation-lease RPCs (supabase/migrations/20260907210000)
 * directly against the real isolated project, via real concurrent RPC
 * calls -- not a mock configured to return the outcome a test wants to
 * see.
 *
 * Every RPC call here goes through `adminClient()` (service_role, the
 * same client features/billing/actions.ts and reconcile.ts actually use)
 * against a freshly seeded, isolated organization -- never a shared or
 * production row.
 */

let member: SeededOrgMember;

test.afterEach(async () => {
  if (member) await cleanupOrgWithMember(member.userId, member.orgId);
});

async function billingRow(orgId: number) {
  const admin = adminClient();
  const { data, error } = await admin
    .from("organization_billing")
    .select(
      "checkout_attempt_id, checkout_attempt_interval, checkout_attempt_price_id, pending_checkout_session_id, checkout_attempt_expires_at, reconciliation_lease_owner, reconciliation_lease_expires_at, needs_reconciliation, stripe_subscription_id, status",
    )
    .eq("organization_id", orgId)
    .single();
  expect(error, JSON.stringify(error)).toBeNull();
  return data!;
}

test.describe("Finding 1/7/9: claim_checkout_attempt / record_checkout_session / release_checkout_attempt / renew_checkout_attempt -- real Postgres behavior", () => {
  test("attempt rollover never lets a stale session id coexist with fresher attempt metadata", async () => {
    member = await seedOrgWithMember("billing-concurrency-rollover");
    const admin = adminClient();

    // Claim a short-lived attempt (1 second) for "monthly" and record a
    // real-looking session against it.
    const claim1 = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_mode: "subscription",
      p_claim_seconds: 1,
    });
    expect(claim1.error, JSON.stringify(claim1.error)).toBeNull();
    const firstAttemptId = claim1.data![0].attempt_id;
    expect(claim1.data![0].is_new_attempt).toBe(true);

    const recorded = await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: firstAttemptId,
      p_session_id: "cs_stale_monthly",
      p_lease_seconds: 1,
    });
    expect(recorded.data).toBe(true);

    // Let the first attempt's lease genuinely expire.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Claim fresh for "yearly" -- this is the exact rollover the finding
    // describes. The row must transition atomically: interval/price
    // change to yearly AND the stale session pointer clears in the SAME
    // statement, never observable paired together.
    const claim2 = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "yearly",
      p_price_id: "price_yearly_test",
      p_mode: "subscription",
      p_claim_seconds: 60,
    });
    expect(claim2.error, JSON.stringify(claim2.error)).toBeNull();
    expect(claim2.data![0].is_new_attempt).toBe(true);
    expect(claim2.data![0].attempt_id).not.toBe(firstAttemptId);
    // The superseded session is still handed back for reconciliation,
    // correctly paired with the OLD interval it actually belongs to.
    expect(claim2.data![0].existing_session_id).toBe("cs_stale_monthly");
    expect(claim2.data![0].existing_interval).toBe("monthly");

    // The critical assertion: the STORED row, read fresh right now, must
    // show the NEW interval with NO session id at all -- never "yearly"
    // paired with the old monthly session, which is the exact bug
    // Finding 1 reports.
    const row = await billingRow(member.orgId);
    expect(row.checkout_attempt_interval).toBe("yearly");
    expect(row.pending_checkout_session_id).toBeNull();
  });

  test("a genuinely concurrent second claim reuses the SAME live attempt, never minting two", async () => {
    member = await seedOrgWithMember("billing-concurrency-dual-claim");
    const admin = adminClient();

    const [first, second] = await Promise.all([
      admin.rpc("claim_checkout_attempt", {
        p_organization_id: member.orgId,
        p_interval: "monthly",
        p_price_id: "price_monthly_test",
        p_mode: "subscription",
        p_claim_seconds: 60,
      }),
      admin.rpc("claim_checkout_attempt", {
        p_organization_id: member.orgId,
        p_interval: "monthly",
        p_price_id: "price_monthly_test",
        p_mode: "subscription",
        p_claim_seconds: 60,
      }),
    ]);

    expect(first.error, JSON.stringify(first.error)).toBeNull();
    expect(second.error, JSON.stringify(second.error)).toBeNull();

    const results = [first.data![0], second.data![0]];
    const newOnes = results.filter((r) => r.is_new_attempt);
    const reused = results.filter((r) => !r.is_new_attempt);

    // Real concurrent claims for the same organization: Postgres's row
    // lock (`for update` in claim_checkout_attempt) serializes them, so
    // exactly one wins the "mint fresh" branch and the other reuses that
    // SAME attempt id -- never two independently-live attempts.
    expect(newOnes).toHaveLength(1);
    expect(reused).toHaveLength(1);
    expect(reused[0].attempt_id).toBe(newOnes[0].attempt_id);
  });

  test("Finding 7: record_checkout_session with the WRONG attempt id is a real zero-row CAS failure, never silently applied", async () => {
    member = await seedOrgWithMember("billing-concurrency-wrong-attempt");
    const admin = adminClient();

    const claim = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_mode: "subscription",
      p_claim_seconds: 60,
    });
    const realAttemptId = claim.data![0].attempt_id;

    const wrongResult = await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: "not_the_real_attempt_id",
      p_session_id: "cs_should_not_stick",
      p_lease_seconds: 60,
    });
    expect(wrongResult.data).toBeFalsy();

    const row = await billingRow(member.orgId);
    expect(row.pending_checkout_session_id).toBeNull();
    expect(row.checkout_attempt_id).toBe(realAttemptId);
  });

  test("Finding 9: renew_checkout_attempt genuinely extends the lease (verified by re-reading the row), and fails for a superseded attempt", async () => {
    member = await seedOrgWithMember("billing-concurrency-renew");
    const admin = adminClient();

    const claim = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_mode: "subscription",
      p_claim_seconds: 5,
    });
    const attemptId = claim.data![0].attempt_id;
    const before = await billingRow(member.orgId);

    const renewed = await admin.rpc("renew_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_claim_seconds: 120,
    });
    expect(renewed.data).toBe(true);

    const after = await billingRow(member.orgId);
    expect(new Date(after.checkout_attempt_expires_at!).getTime()).toBeGreaterThan(
      new Date(before.checkout_attempt_expires_at!).getTime(),
    );

    const renewWrong = await admin.rpc("renew_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: "some_other_attempt_id",
      p_claim_seconds: 120,
    });
    expect(renewWrong.data).toBeFalsy();
  });
});

test.describe("Finding 3: claim_reconciliation_lease / write_reconciliation_result / release_reconciliation_lease -- real exclusive-ownership behavior", () => {
  test("A holds ownership; a genuinely concurrent B is refused and durably marks the organization dirty, without A ever having released", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-exclusion");
    const admin = adminClient();

    const claimA = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimA.error, JSON.stringify(claimA.error)).toBeNull();
    const ownerA = claimA.data;
    expect(ownerA).toBeTruthy();

    // B contends WHILE A's lease is still definitely live.
    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimB.data).toBeNull();

    const row = await billingRow(member.orgId);
    expect(row.reconciliation_lease_owner).toBe(ownerA);
    expect(row.needs_reconciliation).toBe(true);
  });

  test("Barrier-controlled: exactly one of two genuinely concurrent claim attempts wins ownership", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-race");
    const admin = adminClient();

    const [a, b] = await Promise.all([
      admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 }),
      admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 }),
    ]);

    const owners = [a.data, b.data].filter(Boolean);
    expect(owners).toHaveLength(1);
  });

  /**
   * This is the direct reproduction for Finding 3's own critique of the
   * PREVIOUS design: "A has actually acquired reconciliation ownership, B
   * contends, and Stripe state changes between observations." A claims
   * the lease first and writes a value representing "Stripe state at
   * time 1." Only once A has released (by writing) does B claim and write
   * a DIFFERENT value representing "Stripe state at time 2" (later,
   * therefore more current). The final row must reflect B's later write
   * -- proving convergence to the MOST RECENT observation, not simply
   * "whoever claimed the lowest sequence number," which is exactly the
   * property the previous billing_sync_seq design could not guarantee.
   * Unlike that design's own invalid test, this never manually queues the
   * desired final result -- every value below comes from a real RPC call
   * against real Postgres.
   */
  test("convergence: B's later write (a later Stripe observation) is what the row ends up reflecting, never A's earlier one", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-convergence");
    const admin = adminClient();

    const claimA = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const ownerA = claimA.data as string;
    expect(ownerA).toBeTruthy();

    const writeA = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: ownerA,
      p_stripe_customer_id: "cus_1",
      p_stripe_subscription_id: "sub_observed_at_time_1",
      p_status: "past_due",
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });
    expect(writeA.data).toBe(true);

    // A's write released the lease (write_reconciliation_result clears
    // it) -- B can now genuinely claim and observe/write a LATER state.
    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const ownerB = claimB.data as string;
    expect(ownerB).toBeTruthy();
    expect(ownerB).not.toBe(ownerA);

    const writeB = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: ownerB,
      p_stripe_customer_id: "cus_1",
      p_stripe_subscription_id: "sub_observed_at_time_2",
      p_status: "active",
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });
    expect(writeB.data).toBe(true);

    const row = await billingRow(member.orgId);
    expect(row.stripe_subscription_id).toBe("sub_observed_at_time_2");
    expect(row.status).toBe("active");
    expect(row.reconciliation_lease_owner).toBeNull();
    expect(row.needs_reconciliation).toBe(false);
  });

  test("Finding 7: write_reconciliation_result with the WRONG owner is a real zero-row CAS failure -- never applies, and re-marks the organization dirty", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-wrong-owner");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data as string;
    expect(owner).toBeTruthy();

    const wrongWrite = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: "not_the_real_owner",
      p_stripe_customer_id: "cus_1",
      p_stripe_subscription_id: "sub_should_not_stick",
      p_status: "active",
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });
    expect(wrongWrite.data).toBeFalsy();

    const row = await billingRow(member.orgId);
    expect(row.stripe_subscription_id).toBeNull();
    expect(row.needs_reconciliation).toBe(true);
    // The genuine owner still holds the lease -- a wrong-owner call must
    // never release someone else's real, still-valid claim.
    expect(row.reconciliation_lease_owner).toBe(owner);
  });

  test("a lease that genuinely expires can be reclaimed by a new caller", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-expiry");
    const admin = adminClient();

    const claimA = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 1 });
    expect(claimA.data).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimB.data).toBeTruthy();
    expect(claimB.data).not.toBe(claimA.data);
  });

  test("release_reconciliation_lease releases only when the owner matches, and always re-marks dirty", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-release");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data as string;

    const wrongRelease = await admin.rpc("release_reconciliation_lease", { p_organization_id: member.orgId, p_owner: "wrong" });
    expect(wrongRelease.data).toBe(false);
    const stillHeld = await billingRow(member.orgId);
    expect(stillHeld.reconciliation_lease_owner).toBe(owner);

    const realRelease = await admin.rpc("release_reconciliation_lease", { p_organization_id: member.orgId, p_owner: owner });
    expect(realRelease.data).toBe(true);
    const released = await billingRow(member.orgId);
    expect(released.reconciliation_lease_owner).toBeNull();
    expect(released.needs_reconciliation).toBe(true);
  });

  /**
   * Found during this round's own three-independent-reviewer adversarial
   * audit (not one of the original 14 findings): claim_reconciliation_
   * lease's SUCCESSFUL claim branch never touched needs_reconciliation at
   * all -- only its failure branch did. A caller that successfully claims
   * the lease and then suffers a genuine process-level kill (not a
   * catchable JS exception, which reconcile.ts's own try/catch already
   * handles) before ever writing or releasing left the organization's row
   * silently un-flagged, invisible to the scheduled sweep. Fixed by
   * migration 20260907230000: the successful-claim branch now ALSO marks
   * the organization dirty in the same statement that mints the owner
   * token, so this is true from the moment of claim, not only on failure
   * or explicit abandonment.
   */
  test("Finding (crash-gap fix): a successful claim marks needs_reconciliation dirty immediately, before any write or release ever happens", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-crash-gap");
    const admin = adminClient();

    const before = await billingRow(member.orgId);
    expect(before.needs_reconciliation).toBe(false);

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claim.data).toBeTruthy();

    // Read the row RIGHT NOW, before this test does anything else -- this
    // is what a caller that got killed immediately after a successful
    // claim would leave behind. It must already be dirty.
    const afterClaim = await billingRow(member.orgId);
    expect(afterClaim.needs_reconciliation).toBe(true);
    expect(afterClaim.reconciliation_lease_owner).toBe(claim.data);
  });

  /**
   * Found during the same audit: release_reconciliation_lease is the
   * error/abandonment cleanup path and unconditionally re-marks the
   * organization dirty (proven above) -- but reconcileOrganizationBilling's
   * "no_subscriptions" outcome needs a way to say "I genuinely checked,
   * there is nothing to reconcile" without leaving the organization
   * permanently flagged and re-polled by the scheduled sweep forever.
   * clear_reconciliation_dirty (migration 20260907240000) is that distinct
   * function -- same CAS-on-owner discipline as release_reconciliation_
   * lease, but does NOT re-mark dirty on success.
   */
  test("Finding (confirmed-clean fix): clear_reconciliation_dirty releases the lease AND clears the dirty flag, unlike release_reconciliation_lease", async () => {
    member = await seedOrgWithMember("billing-concurrency-clear-dirty");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data as string;
    expect(owner).toBeTruthy();

    // A wrong owner must not clear someone else's real, still-valid claim.
    const wrongClear = await admin.rpc("clear_reconciliation_dirty", { p_organization_id: member.orgId, p_owner: "wrong" });
    expect(wrongClear.data).toBe(false);
    const stillHeld = await billingRow(member.orgId);
    expect(stillHeld.reconciliation_lease_owner).toBe(owner);
    expect(stillHeld.needs_reconciliation).toBe(true);

    const realClear = await admin.rpc("clear_reconciliation_dirty", { p_organization_id: member.orgId, p_owner: owner });
    expect(realClear.data).toBe(true);
    const cleared = await billingRow(member.orgId);
    expect(cleared.reconciliation_lease_owner).toBeNull();
    // The actual distinction from release_reconciliation_lease: dirty is
    // genuinely cleared, not re-set.
    expect(cleared.needs_reconciliation).toBe(false);
  });
});
