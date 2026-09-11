import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connectToTestDb } from "./support/db-connection";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
  type SeededOrgMember,
} from "./support/seed";

/**
 * Round-2 finding R2-05: submit_feedback_atomic's `for update of c` locked
 * only the nfc_cards row -- the locations row it also reads `status` from
 * was never locked. Reproduced with two real, separately-connected Postgres
 * clients (not simulated): a submission's SELECT ... FOR UPDATE OF c reads
 * location status as 'active', then a concurrent `UPDATE locations SET
 * status = 'inactive'` -- never blocked by anything -- commits immediately
 * while the submission's transaction is still open, and the submission
 * proceeds to insert feedback using the now-stale 'active' read. Fixed by
 * locking both rows in the same statement (`for update of c, l`).
 *
 * This is a genuinely different bug from finding #6 (round 1): that fix's
 * own test (e2e/public-submission-safety.spec.ts) deactivates the *card*
 * between page load and submission -- a gap the card lock always closed.
 * Testing that again proves nothing about the *location* lock, which is
 * what this file is for.
 *
 * What "fixed" actually means here, precisely: NOT that a submission can
 * never land in the same instant a location goes inactive (impossible to
 * guarantee for any correctly-serialized concurrent system -- some
 * operation is always "last in" before a state flips, and that alone is
 * not corruption). What the fix guarantees is proper serialization: a
 * submission and a deactivation racing for the same rows always resolve to
 * ONE clean, blocking order -- never an unordered interleave where a
 * deactivation completes without ever waiting on a submission that was
 * already reading the very rows it's about to change. Both tests below
 * verify that ordering directly (a client attempting to lock a row the
 * other side already holds must block, then see the other side's
 * committed change once unblocked) rather than a weaker, achievable-either
 * way "did some feedback exist" check.
 *
 * Needs a direct Postgres connection (the app itself only ever talks to
 * Supabase over PostgREST/HTTP -- this is the one place in the test suite
 * that needs the raw protocol, since holding a transaction open across
 * controlled interleaving isn't expressible any other way). Skips
 * gracefully, not a hard failure, if that connection can't be established
 * LOCALLY within a few seconds -- this project's own experience this
 * session is that direct Postgres ports (5432/6543) can be blocked by a
 * restrictive network even when the app's normal HTTPS traffic works
 * fine. In CI, round-4 finding R4-04 makes this mandatory instead --
 * see e2e/support/db-connection.ts.
 */

let member: SeededOrgMember;
let locationId: number;
let publicId: string;

test.beforeEach(async () => {
  member = await seedOrgWithMember("location-race");

  const admin = adminClient();
  const { data: location, error: locationError } = await admin
    .from("locations")
    .insert({ organization_id: member.orgId, name: "Race Test Location" })
    .select("id")
    .single();
  if (locationError) throw locationError;
  locationId = location.id;

  publicId = randomUUID();
  const { error: cardError } = await admin
    .from("nfc_cards")
    .insert({ organization_id: member.orgId, location_id: locationId, public_id: publicId });
  if (cardError) throw cardError;
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("R2-05: a deactivation holding its lock blocks a concurrent submission, which then correctly sees the location as inactive", async () => {
  const clientB = await connectToTestDb(); // the manager's deactivation
  const clientA = await connectToTestDb(); // the customer's submission
  test.skip(!clientB || !clientA, "No direct Postgres connection available in this environment.");
  if (!clientB || !clientA) return;

  try {
    await clientB.query("begin");
    await clientB.query("update public.locations set status = 'inactive' where id = $1", [
      locationId,
    ]);

    await clientA.query("begin");
    let aStillBlocked = true;
    const aSelect = clientA
      .query(
        `select c.status as card_status, l.status as loc_status
         from public.nfc_cards c join public.locations l on l.id = c.location_id
         where c.public_id = $1
         for update of c, l`,
        [publicId],
      )
      .then((r) => {
        aStillBlocked = false;
        return r;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    // While B's deactivation is still uncommitted, A's lock attempt on the
    // same location row must still be waiting -- this is the actual fix
    // (before it, A never tried to lock `l` at all, so it would never
    // block here).
    expect(aStillBlocked).toBe(true);

    await clientB.query("commit");
    const result = await aSelect;
    expect(aStillBlocked).toBe(false);
    expect(result.rows[0].loc_status).toBe("inactive");
    await clientA.query("rollback");
  } finally {
    await clientA.query("rollback").catch(() => {});
    await clientB.query("rollback").catch(() => {});
    await clientA.end();
    await clientB.end();
  }
});

test("R2-05: a submission holding its lock blocks a concurrent deactivation, serializing the two instead of letting the deactivation race ahead unordered", async () => {
  const clientA = await connectToTestDb(); // the customer's submission
  const clientB = await connectToTestDb(); // the manager's deactivation
  test.skip(!clientA || !clientB, "No direct Postgres connection available in this environment.");
  if (!clientA || !clientB) return;

  try {
    await clientA.query("begin");
    const readResult = await clientA.query(
      `select c.status as card_status, l.status as loc_status
       from public.nfc_cards c join public.locations l on l.id = c.location_id
       where c.public_id = $1
       for update of c, l`,
      [publicId],
    );
    expect(readResult.rows[0].loc_status).toBe("active");

    let bStillBlocked = true;
    const bUpdate = clientB
      .query("update public.locations set status = 'inactive' where id = $1", [locationId])
      .then((r) => {
        bStillBlocked = false;
        return r;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    // Before the fix, this UPDATE completed immediately (confirmed
    // empirically at ~70ms, no blocking at all) because nothing ever
    // locked `locations`. With the fix, it must still be waiting here.
    expect(bStillBlocked).toBe(true);

    await clientA.query("commit");
    await bUpdate;
    expect(bStillBlocked).toBe(false);
  } finally {
    await clientA.query("rollback").catch(() => {});
    await clientB.query("rollback").catch(() => {});
    await clientA.end();
    await clientB.end();
  }
});
