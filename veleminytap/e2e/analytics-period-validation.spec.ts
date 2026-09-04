import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  userClient,
  type SeededOrgMember,
} from "./support/seed";

/**
 * Round-3 finding R3-04: get_feedback_period_analytics passed
 * caller-controlled p_days directly into generate_series with no
 * validation. The UI only ever requests 7, 30, or 90 (app/dashboard/analytics/page.tsx's
 * VALID_PERIODS), but the function is EXECUTE-granted to `authenticated`
 * and callable directly -- an arbitrary p_days (huge, negative, zero,
 * fractional-as-integer-overflow-adjacent) forced an unbounded or
 * malformed series and a correspondingly unbounded JSON response.
 *
 * Fixed by validating p_days against an explicit allowlist (7/30/90) as
 * the FIRST thing the function does, before generate_series or any table
 * scan runs -- these tests call the RPC directly, as an authenticated
 * member, exactly the caller this finding is about (not through the UI,
 * which never sends an invalid value in the first place).
 */

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("analytics-period-validation");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

for (const days of [7, 30, 90]) {
  test(`R3-04: p_days=${days} (a real UI value) succeeds`, async () => {
    const client = await userClient(member.email, member.password);
    const { data, error } = await client.rpc("get_feedback_period_analytics", {
      p_organization_id: member.orgId,
      p_days: days,
    });
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
}

for (const days of [0, -1, -90, 15, 365, 100000, 2147483647]) {
  test(`R3-04: p_days=${days} is rejected cheaply, not used to build a series`, async () => {
    const client = await userClient(member.email, member.password);
    const { data, error } = await client.rpc("get_feedback_period_analytics", {
      p_organization_id: member.orgId,
      p_days: days,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("p_days must be one of 7, 30, or 90");
    expect(data).toBeNull();
  });
}
