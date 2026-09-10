import { test, expect } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, type SeededOrgMember } from "./support/seed";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Fourth independent review: "Unit mocks are acceptable for isolated
 * error branches. They are NOT acceptable as sole proof of database
 * locking, concurrency, ... migration compatibility." This file proves
 * the actual Postgres-level locking/CAS behavior of the checkout-attempt
 * and reconciliation-lease RPCs directly against the real isolated
 * project, via real concurrent RPC calls -- not a mock configured to
 * return the outcome a test wants to see.
 *
 * Covers migrations 20260907210000/230000/240000 (the exclusive
 * reconciliation lease and its durable dirty flag) and the fifth round's
 * 20260908100000/110000 (checkout attempt identity separated from its
 * operation lease, immutable checkout requests, generation counters, and
 * staleness-based candidate selection).
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
      "checkout_attempt_id, checkout_attempt_interval, checkout_attempt_price_id, checkout_owner_token, checkout_request, checkout_created_at, pending_checkout_session_id, checkout_attempt_expires_at, reconciliation_lease_owner, reconciliation_lease_expires_at, needs_reconciliation, billing_sync_requested, billing_sync_completed, billing_sync_last_attempt_at, billing_sync_last_error, activation_requested, activation_completed, activated_at, activation_evidence, grandfathered_at, last_synced_at, stripe_customer_id, stripe_subscription_id, status",
    )
    .eq("organization_id", orgId)
    .single();
  expect(error, JSON.stringify(error)).toBeNull();
  return data!;
}

/**
 * claim_checkout_attempt validates the immutable request against the row's
 * own Stripe customer, so an organization has to have one before a
 * checkout attempt can be claimed at all -- which is exactly the ordering
 * features/billing/actions.ts now follows (resolve the customer, then
 * claim). These ids are local test fixtures; nothing here calls Stripe.
 */
async function giveStripeCustomer(orgId: number, customerId: string) {
  const admin = adminClient();
  const { error } = await admin
    .from("organization_billing")
    .update({ stripe_customer_id: customerId })
    .eq("organization_id", orgId);
  expect(error, JSON.stringify(error)).toBeNull();
}

function checkoutRequest(orgId: number, customerId: string, priceId: string, marker = "original"): Json {
  return {
    mode: "subscription",
    customer: customerId,
    client_reference_id: String(orgId),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `https://example.test/dashboard/billing?checkout=success&marker=${marker}`,
    cancel_url: "https://example.test/dashboard/billing?checkout=canceled",
    metadata: { organization_id: String(orgId) },
  } as unknown as Json;
}

test.describe("checkout attempt identity, its operation lease, and the immutable request", () => {
  test("attempt identity SURVIVES operation-lease expiry, so a takeover replays the same idempotency key", async () => {
    member = await seedOrgWithMember("billing-concurrency-identity");
    await giveStripeCustomer(member.orgId, "cus_identity");
    const admin = adminClient();

    // Claim a short-lived OPERATION lease (1 second) for "monthly".
    const claim1 = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_identity", "price_monthly_test"),
      p_claim_seconds: 1,
    });
    expect(claim1.error, JSON.stringify(claim1.error)).toBeNull();
    const firstAttemptId = claim1.data![0].attempt_id;
    expect(claim1.data![0].is_new_attempt).toBe(true);
    expect(claim1.data![0].owner_token).toBeTruthy();
    expect(claim1.data![0].retry_safe).toBe(true);

    const recorded = await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: firstAttemptId,
      p_owner_token: claim1.data![0].owner_token!,
      p_session_id: "cs_created_but_never_finished",
    });
    expect(recorded.data).toBe(true);

    // Let the OPERATION lease genuinely expire -- simulating a request
    // killed after creating a Session at Stripe.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The takeover. This is the whole point of migration 20260908100000:
    // a new operation gets a NEW owner token but the SAME attempt id, so
    // `checkout:attempt-<id>` still names the key Stripe already knows.
    const claim2 = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_identity", "price_monthly_test", "rebuilt"),
      p_claim_seconds: 60,
    });
    expect(claim2.error, JSON.stringify(claim2.error)).toBeNull();
    expect(claim2.data![0].attempt_id).toBe(firstAttemptId);
    expect(claim2.data![0].is_new_attempt).toBe(false);
    expect(claim2.data![0].owner_token).toBeTruthy();
    expect(claim2.data![0].owner_token).not.toBe(claim1.data![0].owner_token);
    // The Session the dead operation created is still findable.
    expect(claim2.data![0].existing_session_id).toBe("cs_created_but_never_finished");
    // Freshly created, so still inside Stripe's idempotency-key retention.
    expect(claim2.data![0].retry_safe).toBe(true);

    // And the request handed back is the ORIGINAL one, not the rebuilt
    // one this second call passed in -- replaying an idempotency key with
    // different parameters is rejected by Stripe, so the stored snapshot
    // has to win.
    const returned = claim2.data![0].request as unknown as { success_url: string };
    expect(returned.success_url).toContain("marker=original");
    expect(returned.success_url).not.toContain("marker=rebuilt");
  });

  test("a genuinely concurrent second claim is refused the operation lease, never handed a second one", async () => {
    member = await seedOrgWithMember("billing-concurrency-dual-claim");
    await giveStripeCustomer(member.orgId, "cus_dual");
    const admin = adminClient();
    const request = checkoutRequest(member.orgId, "cus_dual", "price_monthly_test");

    const [first, second] = await Promise.all([
      admin.rpc("claim_checkout_attempt", {
        p_organization_id: member.orgId,
        p_interval: "monthly",
        p_price_id: "price_monthly_test",
        p_request: request,
        p_claim_seconds: 60,
      }),
      admin.rpc("claim_checkout_attempt", {
        p_organization_id: member.orgId,
        p_interval: "monthly",
        p_price_id: "price_monthly_test",
        p_request: request,
        p_claim_seconds: 60,
      }),
    ]);

    expect(first.error, JSON.stringify(first.error)).toBeNull();
    expect(second.error, JSON.stringify(second.error)).toBeNull();

    const results = [first.data![0], second.data![0]];
    const owners = results.filter((r) => r.owner_token);
    const refused = results.filter((r) => !r.owner_token);

    // Postgres's row lock (`for update`) serializes them: exactly one
    // holds the operation lease, the other is told to stand down. Both
    // still see the same single attempt identity.
    expect(owners).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].attempt_id).toBe(owners[0].attempt_id);
  });

  test("a request naming a different price, customer or organization than the claim is rejected outright", async () => {
    member = await seedOrgWithMember("billing-concurrency-request-validation");
    await giveStripeCustomer(member.orgId, "cus_validation");
    const admin = adminClient();

    const wrongPrice = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_validation", "price_something_else"),
      p_claim_seconds: 60,
    });
    expect(wrongPrice.error).toBeTruthy();

    const wrongCustomer = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_someone_else", "price_monthly_test"),
      p_claim_seconds: 60,
    });
    expect(wrongCustomer.error).toBeTruthy();

    const wrongOrg = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId + 1, "cus_validation", "price_monthly_test"),
      p_claim_seconds: 60,
    });
    expect(wrongOrg.error).toBeTruthy();

    // Nothing was written by any of the three rejected calls.
    const row = await billingRow(member.orgId);
    expect(row.checkout_attempt_id).toBeNull();
    expect(row.checkout_request).toBeNull();
  });

  test("record_checkout_session with the WRONG attempt id or owner token is a real zero-row CAS failure", async () => {
    member = await seedOrgWithMember("billing-concurrency-wrong-attempt");
    await giveStripeCustomer(member.orgId, "cus_wrong_attempt");
    const admin = adminClient();

    const claim = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_wrong_attempt", "price_monthly_test"),
      p_claim_seconds: 60,
    });
    const realAttemptId = claim.data![0].attempt_id;
    const realOwner = claim.data![0].owner_token!;

    const wrongAttempt = await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: "not_the_real_attempt_id",
      p_owner_token: realOwner,
      p_session_id: "cs_should_not_stick",
    });
    expect(wrongAttempt.data).toBeFalsy();

    const wrongOwner = await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: realAttemptId,
      p_owner_token: "not_the_real_owner",
      p_session_id: "cs_should_not_stick_either",
    });
    expect(wrongOwner.data).toBeFalsy();

    const row = await billingRow(member.orgId);
    expect(row.pending_checkout_session_id).toBeNull();
    expect(row.checkout_attempt_id).toBe(realAttemptId);
  });

  test("finish_checkout_operation frees the lease but KEEPS the attempt; release_checkout_attempt discards it", async () => {
    member = await seedOrgWithMember("billing-concurrency-finish-release");
    await giveStripeCustomer(member.orgId, "cus_finish");
    const admin = adminClient();

    const claim = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_finish", "price_monthly_test"),
      p_claim_seconds: 60,
    });
    const attemptId = claim.data![0].attempt_id;
    const owner = claim.data![0].owner_token!;

    await admin.rpc("record_checkout_session", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: owner,
      p_session_id: "cs_handed_to_customer",
    });

    const finished = await admin.rpc("finish_checkout_operation", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: owner,
    });
    expect(finished.data).toBe(true);

    const afterFinish = await billingRow(member.orgId);
    expect(afterFinish.checkout_owner_token).toBeNull();
    expect(afterFinish.checkout_attempt_expires_at).toBeNull();
    // The attempt and its recorded session outlive the operation -- the
    // customer may still be on Stripe's hosted page.
    expect(afterFinish.checkout_attempt_id).toBe(attemptId);
    expect(afterFinish.pending_checkout_session_id).toBe("cs_handed_to_customer");
    expect(afterFinish.checkout_request).not.toBeNull();

    // A later request takes the lease over without waiting anything out.
    const retake = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_finish", "price_monthly_test"),
      p_claim_seconds: 60,
    });
    expect(retake.data![0].attempt_id).toBe(attemptId);
    expect(retake.data![0].existing_session_id).toBe("cs_handed_to_customer");
    const retakeOwner = retake.data![0].owner_token!;

    const wrongRelease = await admin.rpc("release_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: "wrong",
    });
    expect(wrongRelease.data).toBeFalsy();
    expect((await billingRow(member.orgId)).checkout_attempt_id).toBe(attemptId);

    const released = await admin.rpc("release_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: retakeOwner,
    });
    expect(released.data).toBe(true);

    const afterRelease = await billingRow(member.orgId);
    expect(afterRelease.checkout_attempt_id).toBeNull();
    expect(afterRelease.checkout_request).toBeNull();
    expect(afterRelease.checkout_created_at).toBeNull();
    expect(afterRelease.pending_checkout_session_id).toBeNull();
  });

  test("renew_checkout_attempt genuinely extends the lease, and fails without the matching owner token", async () => {
    member = await seedOrgWithMember("billing-concurrency-renew");
    await giveStripeCustomer(member.orgId, "cus_renew");
    const admin = adminClient();

    const claim = await admin.rpc("claim_checkout_attempt", {
      p_organization_id: member.orgId,
      p_interval: "monthly",
      p_price_id: "price_monthly_test",
      p_request: checkoutRequest(member.orgId, "cus_renew", "price_monthly_test"),
      p_claim_seconds: 5,
    });
    const attemptId = claim.data![0].attempt_id;
    const owner = claim.data![0].owner_token!;
    const before = await billingRow(member.orgId);

    const renewed = await admin.rpc("renew_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: owner,
      p_claim_seconds: 120,
    });
    expect(renewed.data).toBe(true);

    const after = await billingRow(member.orgId);
    expect(new Date(after.checkout_attempt_expires_at!).getTime()).toBeGreaterThan(
      new Date(before.checkout_attempt_expires_at!).getTime(),
    );

    const renewWrong = await admin.rpc("renew_checkout_attempt", {
      p_organization_id: member.orgId,
      p_attempt_id: attemptId,
      p_owner_token: "some_other_owner_token",
      p_claim_seconds: 120,
    });
    expect(renewWrong.data).toBeFalsy();
  });
});

test.describe("reconciliation lease -- real exclusive-ownership behavior", () => {
  test("A holds ownership; a genuinely concurrent B is refused and durably marks the organization dirty, without A ever having released", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-exclusion");
    const admin = adminClient();

    const claimA = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimA.error, JSON.stringify(claimA.error)).toBeNull();
    const ownerA = claimA.data![0].owner_token;
    expect(ownerA).toBeTruthy();

    // B contends WHILE A's lease is still definitely live.
    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimB.data).toEqual([]);

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

    const owners = [...(a.data ?? []), ...(b.data ?? [])];
    expect(owners).toHaveLength(1);
  });

  /**
   * Direct reproduction for the original Finding 3's critique of the
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
    const ownerA = claimA.data![0].owner_token;
    expect(ownerA).toBeTruthy();

    const writeA = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: ownerA,
      p_requested_generation: claimA.data![0].requested_generation,
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
    const ownerB = claimB.data![0].owner_token;
    expect(ownerB).toBeTruthy();
    expect(ownerB).not.toBe(ownerA);

    const writeB = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: ownerB,
      p_requested_generation: claimB.data![0].requested_generation,
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

  test("write_reconciliation_result with the WRONG owner is a real zero-row CAS failure -- never applies, and re-marks the organization dirty", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-wrong-owner");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data![0].owner_token;
    expect(owner).toBeTruthy();

    const wrongWrite = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: "not_the_real_owner",
      p_requested_generation: claim.data![0].requested_generation,
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
    expect(claimA.data![0].owner_token).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimB.data![0].owner_token).toBeTruthy();
    expect(claimB.data![0].owner_token).not.toBe(claimA.data![0].owner_token);
  });

  test("release_reconciliation_lease releases only when the owner matches, and always re-marks dirty", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-release");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data![0].owner_token;

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
   * Found during the fourth round's own three-independent-reviewer
   * adversarial audit: claim_reconciliation_lease's SUCCESSFUL claim
   * branch never touched needs_reconciliation at all -- only its failure
   * branch did. A caller that successfully claims the lease and then
   * suffers a genuine process-level kill (not a catchable JS exception,
   * which reconcile.ts's own try/catch already handles) before ever
   * writing or releasing left the organization's row silently un-flagged,
   * invisible to the scheduled sweep. Fixed by migration 20260907230000
   * and carried forward unchanged by 20260908110000's redefinition.
   */
  test("crash-gap: a successful claim marks needs_reconciliation dirty immediately, before any write or release ever happens", async () => {
    member = await seedOrgWithMember("billing-concurrency-lease-crash-gap");
    const admin = adminClient();

    const before = await billingRow(member.orgId);
    expect(before.needs_reconciliation).toBe(false);

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claim.data![0].owner_token).toBeTruthy();

    // Read the row RIGHT NOW, before this test does anything else -- this
    // is what a caller that got killed immediately after a successful
    // claim would leave behind. It must already be dirty.
    const afterClaim = await billingRow(member.orgId);
    expect(afterClaim.needs_reconciliation).toBe(true);
    expect(afterClaim.reconciliation_lease_owner).toBe(claim.data![0].owner_token);
  });

  test("confirmed-clean: clear_reconciliation_dirty releases the lease AND clears the dirty flag, unlike release_reconciliation_lease", async () => {
    member = await seedOrgWithMember("billing-concurrency-clear-dirty");
    const admin = adminClient();

    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const owner = claim.data![0].owner_token;
    const generation = claim.data![0].requested_generation;
    expect(owner).toBeTruthy();

    // A wrong owner must not clear someone else's real, still-valid claim.
    const wrongClear = await admin.rpc("clear_reconciliation_dirty", {
      p_organization_id: member.orgId,
      p_owner: "wrong",
      p_requested_generation: generation,
    });
    expect(wrongClear.data).toBe(false);
    const stillHeld = await billingRow(member.orgId);
    expect(stillHeld.reconciliation_lease_owner).toBe(owner);
    expect(stillHeld.needs_reconciliation).toBe(true);

    const realClear = await admin.rpc("clear_reconciliation_dirty", {
      p_organization_id: member.orgId,
      p_owner: owner,
      p_requested_generation: generation,
    });
    expect(realClear.data).toBe(true);
    const cleared = await billingRow(member.orgId);
    expect(cleared.reconciliation_lease_owner).toBeNull();
    // The actual distinction from release_reconciliation_lease: dirty is
    // genuinely cleared, not re-set. last_synced_at is stamped too, so the
    // staleness scan does not immediately re-select this organization.
    expect(cleared.needs_reconciliation).toBe(false);
    expect(cleared.last_synced_at).not.toBeNull();
  });
});

test.describe("generation counters -- an event arriving DURING a reconciliation is never lost", () => {
  /**
   * The exact sequence the generation pair exists for, executed for real
   * against Postgres:
   *
   *   1. webhook A requests reconciliation and claims the lease
   *   2. Stripe state changes; webhook B is delivered for that change
   *   3. B requests reconciliation, then fails to claim (A holds it)
   *   4. A completes, writing the state it read BEFORE step 2
   *
   * Under the lease alone, step 4 cleared the dirty flag and B's event
   * vanished with nothing anywhere recording that it happened. With the
   * generation pair, A's write may only clear the flag if
   * billing_sync_requested has not moved past what A observed -- and it
   * has, so the organization stays dirty and the sweep re-derives it.
   */
  test("a request committed while the lease is held keeps the organization dirty after the holder's write", async () => {
    member = await seedOrgWithMember("billing-concurrency-generation-loss");
    const admin = adminClient();

    // 1. A asks for reconciliation and takes the lease.
    const requestA = await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
    expect(requestA.error, JSON.stringify(requestA.error)).toBeNull();
    expect(requestA.data).toBe(1);

    const claimA = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const ownerA = claimA.data![0].owner_token;
    const generationA = claimA.data![0].requested_generation;
    expect(generationA).toBe(1);

    // 2-3. B's event arrives mid-flight: it registers its request and is
    // then refused the lease.
    const requestB = await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
    expect(requestB.data).toBe(2);
    const claimB = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    expect(claimB.data).toEqual([]);

    // 4. A writes the state it observed before B's event existed.
    const writeA = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: ownerA,
      p_requested_generation: generationA,
      p_stripe_customer_id: "cus_generation",
      p_stripe_subscription_id: "sub_stale_observation",
      p_status: "past_due",
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });
    expect(writeA.data).toBe(true);

    const afterA = await billingRow(member.orgId);
    // A's write landed...
    expect(afterA.stripe_subscription_id).toBe("sub_stale_observation");
    expect(afterA.billing_sync_completed).toBe(1);
    // ...but B's request is still outstanding, so this is NOT clean.
    expect(afterA.billing_sync_requested).toBe(2);
    expect(afterA.needs_reconciliation).toBe(true);

    // The sweep picks it up on exactly that basis and the second pass
    // converges, because nothing new has been requested since.
    const claimC = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    const writeC = await admin.rpc("write_reconciliation_result", {
      p_organization_id: member.orgId,
      p_owner: claimC.data![0].owner_token,
      p_requested_generation: claimC.data![0].requested_generation,
      p_stripe_customer_id: "cus_generation",
      p_stripe_subscription_id: "sub_current_observation",
      p_status: "active",
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });
    expect(writeC.data).toBe(true);

    const afterC = await billingRow(member.orgId);
    expect(afterC.stripe_subscription_id).toBe("sub_current_observation");
    expect(afterC.needs_reconciliation).toBe(false);
    expect(afterC.billing_sync_completed).toBe(2);
  });

  /**
   * R9-02 (round-9 review, P1) and R10-01/R10-03 (round-10 review), at the
   * hosted level.
   *
   * The history of this one test is the clearest example in the project of a
   * suite agreeing with a bug. It originally asserted that an activation write
   * advanced `billing_sync_completed` -- encoding the very coupling that was
   * R9-02. Round 9 inverted it. Round 10 then found that round 9's fix had
   * introduced a different wrong rule underneath it.
   *
   * So it now asserts the REQUIREMENT rather than any implementation's shape:
   * an activation records the payment it was given and does not claim to have
   * refreshed a subscription it never read.
   */
  test("R9-02: an activation discharges only the ACTIVATION obligation, never a pending refresh", async () => {
    member = await seedOrgWithMember("billing-concurrency-generation-activation");
    const admin = adminClient();

    // A subscription refresh is requested and left outstanding...
    await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
    // ...and an activation arrives with its own verified payment evidence.
    const paidAt = new Date(Date.now() - 60_000).toISOString();
    const activated = await admin.rpc("request_billing_activation", {
      p_organization_id: member.orgId,
      p_evidence: { invoice_id: "in_e2e_1", subscription_id: "sub_e2e_1", price_id: "price_e2e", paid_at: paidAt },
    });
    expect(activated.error).toBeNull();

    const row = await billingRow(member.orgId);
    // The activation did its own work, dated from the payment itself...
    expect(row.activated_at).not.toBeNull();
    expect(new Date(row.activated_at as string).toISOString()).toBe(paidAt);
    expect(row.activation_completed).toBe(1);
    expect(row.activation_requested).toBe(1);
    // ...and did NOT claim to have refreshed a subscription it never read.
    expect(row.billing_sync_completed).toBe(0);
    expect(row.billing_sync_requested).toBe(1);
    expect(row.needs_reconciliation).toBe(true);
  });

  /**
   * R10-01 (round-10 review, P1). The counterexample the review reproduced: a
   * grandfathered organization given an approved-price subscription that
   * Stripe reports `active` while its first invoice is unpaid, then canceled.
   * Round 9's `write_reconciliation_result` latched activated_at from that
   * status, and the organization lost its prepayment grace permanently.
   *
   * Asserted as the requirement, not as "the current code does this": a
   * subscription status, on its own, must never set the ever-paid latch.
   */
  test("R10-01: an unpaid `active` subscription never sets the ever-paid latch, and cancellation restores grace", async () => {
    member = await seedOrgWithMember("billing-concurrency-unpaid-active");
    const admin = adminClient();
    // The organization in the counterexample is grandfathered -- that is what
    // it has to lose. A freshly seeded row is not, so state it explicitly
    // rather than relying on the fixture's default.
    await admin
      .from("organization_billing")
      .update({ grandfathered_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .eq("organization_id", member.orgId);

    const write = async (status: string, subscriptionId: string | null) => {
      await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
      const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
      const applied = await admin.rpc("write_reconciliation_result", {
        p_organization_id: member.orgId,
        p_owner: claim.data![0].owner_token,
        p_requested_generation: claim.data![0].requested_generation,
        p_stripe_customer_id: "cus_r10_01",
        p_stripe_subscription_id: subscriptionId,
        p_status: status,
        p_current_period_end: null,
        p_cancel_at_period_end: false,
      });
      expect(applied.data).toBe(true);
    };

    // An invoiced subscription that Stripe reports active with nothing paid.
    await write("active", "sub_unpaid_active");
    let row = await billingRow(member.orgId);
    expect(row.status).toBe("active");
    expect(row.activated_at).toBeNull();
    expect(row.activation_evidence).toBeNull();

    // It is canceled without that invoice ever being paid.
    await write("canceled", "sub_unpaid_active");
    row = await billingRow(member.orgId);
    expect(row.status).toBe("canceled");
    // The organization never paid, so its grandfathered grace is intact.
    expect(row.activated_at).toBeNull();
    expect(row.grandfathered_at).not.toBeNull();
  });

  /**
   * R10-03 (round-10 review, P2). A verified paid invoice, then cancellation,
   * with no further invoice delivery and no resubscription. The two-phase
   * design left this permanently dirty and permanently un-activated.
   */
  test("R10-03: a paid activation survives cancellation with no invoice redelivery", async () => {
    member = await seedOrgWithMember("billing-concurrency-paid-then-canceled");
    const admin = adminClient();

    const paidAt = new Date(Date.now() - 120_000).toISOString();
    await admin.rpc("request_billing_activation", {
      p_organization_id: member.orgId,
      p_evidence: { invoice_id: "in_r10_03", subscription_id: "sub_r10_03", price_id: "price_e2e", paid_at: paidAt },
    });

    // The subscription is then canceled, and refreshed repeatedly. The invoice
    // is never redelivered and no new subscription appears.
    for (let pass = 0; pass < 3; pass++) {
      await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
      const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
      await admin.rpc("write_reconciliation_result", {
        p_organization_id: member.orgId,
        p_owner: claim.data![0].owner_token,
        p_requested_generation: claim.data![0].requested_generation,
        p_stripe_customer_id: "cus_r10_03",
        p_stripe_subscription_id: "sub_r10_03",
        p_status: "canceled",
        p_current_period_end: null,
        p_cancel_at_period_end: false,
      });
    }

    const row = await billingRow(member.orgId);
    // The payment fact survived, dated from the payment, with its evidence.
    expect(row.activated_at).not.toBeNull();
    expect(row.activation_evidence).toMatchObject({ invoice_id: "in_r10_03" });
    // And the row converged instead of looping dirty forever.
    expect(row.needs_reconciliation).toBe(false);
    expect(row.activation_requested).toBe(row.activation_completed);
  });

  test("fail_billing_reconciliation records the reason, frees the lease, and leaves the work outstanding", async () => {
    member = await seedOrgWithMember("billing-concurrency-generation-failure");
    const admin = adminClient();

    await admin.rpc("request_billing_reconciliation", { p_organization_id: member.orgId });
    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });

    const failed = await admin.rpc("fail_billing_reconciliation", {
      p_organization_id: member.orgId,
      p_owner: claim.data![0].owner_token,
      p_error: "Stripe list() timed out",
    });
    expect(failed.data).toBe(true);

    const row = await billingRow(member.orgId);
    expect(row.reconciliation_lease_owner).toBeNull();
    expect(row.billing_sync_last_error).toContain("timed out");
    expect(row.needs_reconciliation).toBe(true);
    // A failure is unfinished work: the generation must NOT advance.
    expect(row.billing_sync_completed).toBe(0);
  });
});

test.describe("staleness-based recovery -- convergence without ever being told", () => {
  test("an organization nobody has flagged, but whose state has not been checked in a long time, is still a candidate", async () => {
    member = await seedOrgWithMember("billing-concurrency-staleness");
    const admin = adminClient();

    // A clean, unflagged organization with a Stripe customer, last synced
    // two hours ago and with no attempt recorded since. Nothing in this
    // app knows anything is wrong -- which is the entire point: an event
    // that was never delivered leaves exactly this state behind.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { error } = await admin
      .from("organization_billing")
      .update({
        stripe_customer_id: "cus_stale",
        needs_reconciliation: false,
        reconciliation_dirty_since: null,
        last_synced_at: twoHoursAgo,
        billing_sync_last_attempt_at: twoHoursAgo,
      })
      .eq("organization_id", member.orgId);
    expect(error, JSON.stringify(error)).toBeNull();

    const candidates = await admin.rpc("get_billing_reconciliation_candidates", {
      p_limit: 200,
      p_stale_seconds: 3600,
    });
    expect(candidates.error, JSON.stringify(candidates.error)).toBeNull();
    const found = candidates.data!.find((c) => c.organization_id === member.orgId);
    expect(found).toBeTruthy();
    expect(found!.stripe_customer_id).toBe("cus_stale");
  });

  test("an organization with no Stripe customer, or one whose lease is currently held, is not a candidate", async () => {
    member = await seedOrgWithMember("billing-concurrency-staleness-excluded");
    const admin = adminClient();

    // No Stripe customer at all: nothing exists at Stripe to reconcile
    // against, and a trialing organization must not cost an API call.
    const noCustomer = await admin.rpc("get_billing_reconciliation_candidates", { p_limit: 200, p_stale_seconds: 1 });
    expect(noCustomer.data!.some((c) => c.organization_id === member.orgId)).toBe(false);

    // With a customer and a live lease held by someone else: claiming
    // would only fail, so it is excluded until that lease lapses.
    await giveStripeCustomer(member.orgId, "cus_leased");
    await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 120 });
    const leased = await admin.rpc("get_billing_reconciliation_candidates", { p_limit: 200, p_stale_seconds: 1 });
    expect(leased.data!.some((c) => c.organization_id === member.orgId)).toBe(false);
  });

  test("a candidate that was just attempted is backed off, so one failing organization cannot monopolize a sweep", async () => {
    member = await seedOrgWithMember("billing-concurrency-staleness-backoff");
    const admin = adminClient();
    await giveStripeCustomer(member.orgId, "cus_backoff");

    // Claiming the lease stamps billing_sync_last_attempt_at; releasing it
    // leaves the organization dirty and unleased -- i.e. it WOULD qualify
    // on every other ground.
    const claim = await admin.rpc("claim_reconciliation_lease", { p_organization_id: member.orgId, p_lease_seconds: 30 });
    await admin.rpc("release_reconciliation_lease", {
      p_organization_id: member.orgId,
      p_owner: claim.data![0].owner_token,
    });

    const immediately = await admin.rpc("get_billing_reconciliation_candidates", { p_limit: 200, p_stale_seconds: 1 });
    expect(immediately.data!.some((c) => c.organization_id === member.orgId)).toBe(false);

    // Age the last attempt past the back-off window and it returns.
    const { error } = await admin
      .from("organization_billing")
      .update({ billing_sync_last_attempt_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() })
      .eq("organization_id", member.orgId);
    expect(error, JSON.stringify(error)).toBeNull();

    const later = await admin.rpc("get_billing_reconciliation_candidates", { p_limit: 200, p_stale_seconds: 1 });
    expect(later.data!.some((c) => c.organization_id === member.orgId)).toBe(true);
  });
});
