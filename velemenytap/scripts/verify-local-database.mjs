// Real PostgreSQL verification of this repo's own migrations, run against a
// disposable local cluster. It deliberately does NOT claim to test Supabase
// Auth or PostgREST -- only what Postgres itself enforces: migration replay,
// locking, CAS/ownership semantics, triggers, grants and RLS. Anything that
// depends on Supabase's hosted services is covered by the Playwright suite
// against the isolated project instead (see e2e/README.md).
//
// Adapted from the harness an independent parallel implementation wrote for
// its own schema, re-pointed at this repo's migration history and RPC names,
// and extended with the checks this repo's design needs that theirs did not
// have (reconciliation generations, confirmed-clean vs abandonment, and
// staleness-based candidate selection).
//
// Creates uniquely named databases; never drops or resets an existing one.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = new URL(process.env.LOCAL_AUDIT_DATABASE_URL ?? "postgresql://audit@127.0.0.1:55439/postgres");
if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.username !== "audit") {
  throw new Error("This harness only supports the disposable localhost:55439 audit cluster.");
}

const connections = [];
let checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};

async function connect(database = "postgres") {
  const address = new URL(url);
  address.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: address.toString() });
  await client.connect();
  connections.push(client);
  return client;
}

const files = (await readdir(path.join(app, "supabase/migrations"))).filter((f) => f.endsWith(".sql")).sort();

// The minimum Supabase-provided SQL surface this repo's migrations reference.
// Nothing here is under test -- it stands in for what the hosted platform
// provides, so the migrations themselves can be exercised honestly.
const bootstrap = `
  create schema auth;
  create schema extensions;
  create extension pgcrypto with schema extensions;
  create table auth.users(id uuid primary key, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
  $$;
  grant usage on schema auth, public, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

async function migrate(client, list) {
  for (const name of list) {
    try {
      await client.query(await readFile(path.join(app, "supabase/migrations", name), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${error.message}`, { cause: error });
    }
  }
}

async function newDatabase(admin, suffix) {
  const name = `vt_audit_${suffix}_${Date.now()}`;
  assert.match(name, /^vt_audit_[a-z]+_\d+$/);
  await admin.query(`create database "${name}"`);
  const client = await connect(name);
  await client.query(bootstrap);
  return { client, name };
}

async function org(client, slug) {
  return (await client.query("insert into public.organizations(name,slug) values($1,$1) returning id", [slug])).rows[0].id;
}

async function seedCustomer(client, id) {
  await client.query("update public.organization_billing set stripe_customer_id=$2 where organization_id=$1", [id, `cus_${id}`]);
}

const requestFor = (id, price = "price_month", marker = "original") => ({
  mode: "subscription",
  customer: `cus_${id}`,
  client_reference_id: String(id),
  line_items: [{ price, quantity: 1 }],
  metadata: { organization_id: String(id) },
  success_url: `https://test.invalid/success?marker=${marker}`,
  cancel_url: "https://test.invalid/cancel",
});

async function checkout(client, id, interval = "monthly", price = "price_month", marker = "original") {
  const result = await client.query("select * from public.claim_checkout_attempt($1,$2,$3,$4::jsonb)", [
    id,
    interval,
    price,
    JSON.stringify(requestFor(id, price, marker)),
  ]);
  return result.rows[0];
}

async function billing(client, id) {
  return (await client.query("select * from public.organization_billing where organization_id=$1", [id])).rows[0];
}

async function claimLease(client, id, seconds = 120) {
  return (await client.query("select * from public.claim_reconciliation_lease($1,$2)", [id, seconds])).rows[0];
}

async function writeResult(client, id, lease, subscription = "sub_current", status = "active") {
  const result = await client.query(
    "select public.write_reconciliation_result($1,$2,$3,$4,$5,$6,$7,null,false) as ok",
    [id, lease.owner_token, lease.requested_generation, lease.activation_generation, `cus_${id}`, subscription, status],
  );
  return result.rows[0].ok;
}

async function waitForDbLock(observer, pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = (await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected a genuine competing database lock");
}

try {
  const admin = await connect();
  for (const role of ["anon", "authenticated", "service_role"]) {
    if (!(await admin.query("select 1 from pg_roles where rolname=$1", [role])).rowCount) {
      await admin.query(`create role ${role} nologin ${role === "service_role" ? "bypassrls" : ""}`);
    }
  }

  // ---------------------------------------------------------------- replay
  const clean = await newDatabase(admin, "clean");
  await migrate(clean.client, files);
  pass(`all ${files.length} migrations replay from empty PostgreSQL (${clean.name})`);

  // Migrations 1-17 are everything up to and including the notification-email
  // change trigger -- the last state that predates billing entirely. An
  // organization created there must survive the remaining migrations with its
  // data untouched and a non-expiring grandfathered grant rather than a
  // surprise trial countdown.
  const upgrade = await newDatabase(admin, "upgrade");
  await migrate(upgrade.client, files.slice(0, 17));
  const legacyId = await org(upgrade.client, "prebilling-hungarian-őű");
  const before = (await upgrade.client.query("select updated_at from public.organizations where id=$1", [legacyId])).rows[0].updated_at;
  await migrate(upgrade.client, files.slice(17));
  const legacy = (
    await upgrade.client.query(
      "select o.updated_at,o.onboarding_tour_status,b.grandfathered_at,b.activated_at,b.billing_sync_requested,b.billing_sync_completed from public.organizations o join public.organization_billing b on b.organization_id=o.id where o.id=$1",
      [legacyId],
    )
  ).rows[0];
  assert.equal(legacy.updated_at.getTime(), before.getTime());
  assert.equal(legacy.onboarding_tour_status, "completed");
  assert.ok(legacy.grandfathered_at);
  assert.equal(legacy.activated_at, null);
  assert.equal(Number(legacy.billing_sync_requested), 0);
  assert.equal(Number(legacy.billing_sync_completed), 0);
  pass(`upgrade from migrations 1-17 preserves existing organization data, grandfathering and the new generation defaults`);

  const client = clean.client;
  const second = await connect(clean.name);
  const third = await connect(clean.name);
  const secondPid = (await second.query("select pg_backend_pid() pid")).rows[0].pid;

  // ------------------------------------------------- checkout attempt/lease
  const id = await org(client, "checkout-concurrency");
  await seedCustomer(client, id);

  const [a, b] = await Promise.all([checkout(client, id), checkout(second, id)]);
  assert.equal([a, b].filter((c) => c.owner_token).length, 1);
  assert.equal(a.attempt_id, b.attempt_id);
  const owned = a.owner_token ? a : b;
  pass("two real connections claim one attempt and exactly one operation owner");

  // A request whose immutable snapshot does not match the claim it would be
  // stored under is refused by the database itself, not merely by the caller.
  for (const [label, args] of [
    ["price", [id, "monthly", "price_month", JSON.stringify(requestFor(id, "price_other"))]],
    ["customer", [id, "monthly", "price_month", JSON.stringify({ ...requestFor(id), customer: "cus_someone_else" })]],
    ["organization", [id, "monthly", "price_month", JSON.stringify({ ...requestFor(id), client_reference_id: String(id + 1) })]],
    ["mode", [id, "monthly", "price_month", JSON.stringify({ ...requestFor(id), mode: "payment" })]],
  ]) {
    await assert.rejects(
      client.query("select * from public.claim_checkout_attempt($1,$2,$3,$4::jsonb)", args),
      (error) => error.code === "VT302",
      `a request naming a different ${label} must be rejected`,
    );
  }
  pass("the database refuses to store a checkout request that misdescribes its own claim");

  assert.equal(
    (await client.query("select public.record_checkout_session($1,$2,$3,'cs_current') as ok", [id, owned.attempt_id, owned.owner_token])).rows[0].ok,
    true,
  );

  // The operation lease expires; the ATTEMPT must not. This is what lets a
  // takeover replay the same `checkout:attempt-<id>` idempotency key instead
  // of creating a second Session at Stripe.
  await client.query("update public.organization_billing set checkout_attempt_expires_at=clock_timestamp()-interval '1 second' where organization_id=$1", [id]);
  const retry = await checkout(second, id, "monthly", "price_month", "rebuilt");
  assert.equal(retry.attempt_id, owned.attempt_id);
  assert.notEqual(retry.owner_token, owned.owner_token);
  assert.equal(retry.is_new_attempt, false);
  assert.equal(retry.existing_session_id, "cs_current");
  assert.equal(retry.retry_safe, true);
  // The ORIGINAL request comes back, never the one this second call passed.
  assert.equal(retry.request.success_url, requestFor(id).success_url);
  pass("attempt identity, its recorded Session and its immutable request all survive operation-lease expiry");

  const staleRecord = (await client.query("select public.record_checkout_session($1,$2,$3,'cs_stale') as ok", [id, owned.attempt_id, owned.owner_token])).rows[0].ok;
  assert.notEqual(staleRecord, true);
  const staleRelease = (await client.query("select public.release_checkout_attempt($1,$2,$3) as ok", [id, owned.attempt_id, owned.owner_token])).rows[0].ok;
  assert.notEqual(staleRelease, true);
  const differentSession = (await client.query("select public.record_checkout_session($1,$2,$3,'cs_other') as ok", [id, retry.attempt_id, retry.owner_token])).rows[0].ok;
  assert.notEqual(differentSession, true);
  pass("a superseded owner can neither record nor release, and no attempt may be bound to a second Session");

  // finish_checkout_operation frees the lease and KEEPS the attempt -- the
  // customer is on Stripe's page and the Session must stay reconcilable.
  assert.equal(
    (await client.query("select public.finish_checkout_operation($1,$2,$3) as ok", [id, retry.attempt_id, retry.owner_token])).rows[0].ok,
    true,
  );
  const finished = await billing(client, id);
  assert.equal(finished.checkout_owner_token, null);
  assert.equal(finished.checkout_attempt_id, retry.attempt_id);
  assert.equal(finished.pending_checkout_session_id, "cs_current");
  assert.ok(finished.checkout_request);
  const retaken = await checkout(second, id, "yearly", "price_year");
  assert.equal(retaken.attempt_id, retry.attempt_id);
  assert.equal(retaken.existing_price_id, "price_month");
  assert.equal(retaken.existing_session_id, "cs_current");
  pass("finishing an operation keeps the attempt; a plan switch cannot repoint the old attempt's own metadata");

  // release_checkout_attempt is the only thing that discards the identity,
  // and only the current owner may do it.
  assert.equal(
    (await client.query("select public.release_checkout_attempt($1,$2,$3) as ok", [id, retaken.attempt_id, retaken.owner_token])).rows[0].ok,
    true,
  );
  const changed = await checkout(client, id, "yearly", "price_year");
  assert.notEqual(changed.attempt_id, retaken.attempt_id);
  assert.equal(changed.existing_price_id, "price_year");
  assert.equal(changed.existing_session_id, null);
  pass("releasing a confirmed-terminal attempt lets a genuinely new one be minted for the new plan");

  // Beyond Stripe's documented idempotency-key retention, replaying the key
  // is no longer deduplicated -- the claim must say so rather than imply the
  // replay is safe.
  await client.query(
    "update public.organization_billing set checkout_owner_token=null,checkout_attempt_expires_at=null,checkout_created_at=clock_timestamp()-interval '24 hours' where organization_id=$1",
    [id],
  );
  assert.equal((await checkout(client, id, "yearly", "price_year")).retry_safe, false);
  pass("an attempt older than the idempotency-key retention window reports retry_safe = false");

  // ------------------------------------------- Stripe customer creation id
  // Stripe documents that Customer Search is NOT read-after-write consistent
  // ("up to an hour behind during outages") and that idempotency keys are
  // pruned after ~24 hours ("we generate a new request if a key is reused
  // after the original is pruned"). Neither covers the whole timeline, so
  // the application has to know WHEN a creation was attempted -- which is
  // what these two columns and three functions exist for.
  const customerOrg = await org(client, "customer-creation-identity");

  const [claimA, claimB] = await Promise.all([
    client.query("select * from public.claim_stripe_customer_creation($1)", [customerOrg]),
    second.query("select * from public.claim_stripe_customer_creation($1)", [customerOrg]),
  ]);
  const cA = claimA.rows[0];
  const cB = claimB.rows[0];
  // They still share ONE creation identity -- but R9-03: exactly one of them
  // may hold the creation OPERATION lease. Letting both proceed is what let a
  // caller on the far side of the 23-hour boundary rotate the key out from
  // under an in-flight create, producing two Customers.
  assert.equal(cA.creation_id, cB.creation_id);
  assert.ok(cA.creation_id);
  assert.equal([cA, cB].filter((c) => c.owner_token).length, 1, "exactly one creation owner");
  assert.equal(cA.customer_id, null);
  const creationOwner = cA.owner_token ? cA : cB;
  assert.equal(creationOwner.retry_safe, true);
  pass("concurrent customer-creation claims share one identity and exactly one operation lease");

  // A wrong identity may not record, and the right one is idempotent.
  assert.notEqual(
    (await client.query("select public.record_stripe_customer($1,$2,$3) as ok", [customerOrg, "not_the_creation_id", "cus_forged"])).rows[0].ok,
    true,
  );
  assert.equal((await billing(client, customerOrg)).stripe_customer_id, null);

  // Rotation must be refused while the frozen key is still live -- that key
  // is the only thing preventing a duplicate in this window.
  assert.equal(
    (await client.query("select public.rotate_stripe_customer_creation($1,$2,$3) as id", [customerOrg, cA.creation_id, creationOwner.owner_token])).rows[0].id,
    null,
  );
  pass("rotation is refused inside the retry-safe window, where the frozen key is still the protection");

  // Age the attempt past the key's documented lifetime.
  await client.query(
    "update public.organization_billing set customer_creation_started_at = clock_timestamp() - interval '30 hours', customer_creation_lease_owner = null, customer_creation_lease_expires_at = null where organization_id=$1",
    [customerOrg],
  );
  const aged = (await client.query("select * from public.claim_stripe_customer_creation($1)", [customerOrg])).rows[0];
  assert.equal(aged.creation_id, cA.creation_id);
  assert.equal(aged.retry_safe, false);

  // Only the holder of the current identity AND its live lease may retire it.
  assert.equal(
    (await client.query("select public.rotate_stripe_customer_creation($1,$2,$3) as id", [customerOrg, "someone_elses_identity", aged.owner_token])).rows[0].id,
    null,
  );
  // R9-03: the right identity but somebody else's lease is refused too.
  assert.equal(
    (await client.query("select public.rotate_stripe_customer_creation($1,$2,$3) as id", [customerOrg, cA.creation_id, "not_the_lease_owner"])).rows[0].id,
    null,
  );
  const rotated = (await client.query("select public.rotate_stripe_customer_creation($1,$2,$3) as id", [customerOrg, cA.creation_id, aged.owner_token])).rows[0].id;
  assert.ok(rotated);
  assert.notEqual(rotated, cA.creation_id);
  // And the retired identity is genuinely dead: it can no longer record.
  assert.notEqual(
    (await client.query("select public.record_stripe_customer($1,$2,$3) as ok", [customerOrg, cA.creation_id, "cus_from_dead_identity"])).rows[0].ok,
    true,
  );
  assert.equal(
    (await client.query("select public.record_stripe_customer($1,$2,$3) as ok", [customerOrg, rotated, "cus_real"])).rows[0].ok,
    true,
  );
  assert.equal((await billing(client, customerOrg)).stripe_customer_id, "cus_real");
  pass("a retired creation identity cannot record; only the rotated successor can");

  // Once resolved, no further identity is ever handed out, and rotation is
  // refused outright -- there is nothing left to create.
  const resolved = (await client.query("select * from public.claim_stripe_customer_creation($1)", [customerOrg])).rows[0];
  assert.equal(resolved.customer_id, "cus_real");
  assert.equal(resolved.creation_id, null);
  assert.equal(
    (await client.query("select public.rotate_stripe_customer_creation($1,$2,$3) as id", [customerOrg, rotated, aged.owner_token])).rows[0].id,
    null,
  );
  // Recording a DIFFERENT customer over a resolved one is refused.
  assert.notEqual(
    (await client.query("select public.record_stripe_customer($1,$2,$3) as ok", [customerOrg, rotated, "cus_second"])).rows[0].ok,
    true,
  );
  assert.equal((await billing(client, customerOrg)).stripe_customer_id, "cus_real");
  pass("a resolved organization hands out no further creation identity and cannot be repointed at a second customer");

  // -------------------------------------------------- reconciliation lease
  const syncOrg = await org(client, "sync-concurrency");
  await seedCustomer(client, syncOrg);

  const requested = (await client.query("select public.request_billing_reconciliation($1) as n", [syncOrg])).rows[0].n;
  assert.equal(Number(requested), 1);
  const [sa, sb] = await Promise.all([claimLease(client, syncOrg), claimLease(second, syncOrg)]);
  assert.equal([sa, sb].filter(Boolean).length, 1);
  const first = sa ?? sb;
  assert.equal(Number(first.requested_generation), 1);
  pass("two real connections contend for the reconciliation lease and exactly one wins");

  // The sequence the generation pair exists for: a second event arrives
  // WHILE the first reconciler holds the lease and is reading Stripe.
  await second.query("select public.request_billing_reconciliation($1)", [syncOrg]);
  assert.equal(await writeResult(client, syncOrg, first, "sub_stale_observation", "past_due"), true);
  let state = await billing(client, syncOrg);
  assert.equal(state.stripe_subscription_id, "sub_stale_observation");
  assert.equal(Number(state.billing_sync_completed), 1);
  assert.equal(Number(state.billing_sync_requested), 2);
  assert.equal(state.needs_reconciliation, true);
  pass("an event arriving during an owned reconciliation leaves durable unfinished work after the holder's write");

  const secondPass = await claimLease(client, syncOrg);
  assert.equal(Number(secondPass.requested_generation), 2);
  assert.equal(await writeResult(client, syncOrg, secondPass, "sub_current_observation"), true);
  state = await billing(client, syncOrg);
  assert.equal(state.stripe_subscription_id, "sub_current_observation");
  assert.equal(state.needs_reconciliation, false);
  assert.equal(Number(state.billing_sync_completed), 2);
  pass("the follow-up pass converges and only then marks the organization clean");

  // A holder whose lease lapses mid-flight must never overwrite whoever
  // legitimately took over.
  const lapsed = await claimLease(client, syncOrg);
  await client.query("update public.organization_billing set reconciliation_lease_expires_at=clock_timestamp()-interval '1 second' where organization_id=$1", [syncOrg]);
  const successor = await claimLease(second, syncOrg);
  assert.notEqual(successor.owner_token, lapsed.owner_token);
  assert.equal(await writeResult(client, syncOrg, lapsed, "sub_from_lapsed_owner", "canceled"), false);
  assert.equal(await writeResult(second, syncOrg, successor, "sub_from_successor"), true);
  assert.equal((await billing(client, syncOrg)).stripe_subscription_id, "sub_from_successor");
  pass("an expired reconciliation owner cannot overwrite its successor's state");

  // Three distinct release paths, three distinct meanings.
  const abandoning = await claimLease(client, syncOrg);
  await client.query("select public.release_reconciliation_lease($1,$2)", [syncOrg, abandoning.owner_token]);
  assert.equal((await billing(client, syncOrg)).needs_reconciliation, true);

  const failing = await claimLease(client, syncOrg);
  await client.query("select public.request_billing_reconciliation($1)", [syncOrg]);
  assert.equal((await client.query("select public.fail_billing_reconciliation($1,$2,'stripe timeout') as ok", [syncOrg, failing.owner_token])).rows[0].ok, true);
  state = await billing(client, syncOrg);
  assert.equal(state.reconciliation_lease_owner, null);
  assert.match(state.billing_sync_last_error, /stripe timeout/);
  assert.ok(Number(state.billing_sync_requested) > Number(state.billing_sync_completed));
  assert.equal(state.needs_reconciliation, true);

  const confirming = await claimLease(client, syncOrg);
  assert.equal(
    (await client.query("select public.clear_reconciliation_dirty($1,$2,$3,$4) as ok", [syncOrg, confirming.owner_token, confirming.requested_generation, confirming.activation_generation])).rows[0].ok,
    true,
  );
  state = await billing(client, syncOrg);
  assert.equal(state.needs_reconciliation, false);
  assert.ok(state.last_synced_at);
  pass("abandonment, failure and confirmed-clean are three genuinely different outcomes in the row");

  // A request that lands between a confirmed-clean claim and its write must
  // still survive -- the same generation rule, on the clean path.
  const clearing = await claimLease(client, syncOrg);
  await second.query("select public.request_billing_reconciliation($1)", [syncOrg]);
  await client.query("select public.clear_reconciliation_dirty($1,$2,$3,$4)", [syncOrg, clearing.owner_token, clearing.requested_generation, clearing.activation_generation]);
  assert.equal((await billing(client, syncOrg)).needs_reconciliation, true);
  pass("confirmed-clean also refuses to discard a request that arrived while it held the lease");

  // ------------------------- R9-02: obligations are not interchangeable
  // An independent round-9 review reproduced, against real SQL, that one
  // shared generation pair let either kind of work mark the other kind's
  // pending requests complete. Both directions are pinned here.
  const obligationOrg = await org(client, "obligation-separation");
  await seedCustomer(client, obligationOrg);

  // Direction 1: an activation must not discharge a pending subscription
  // refresh. A refresh writes an older observation while a newer request
  // arrives, correctly leaving work outstanding; an activation then claims
  // a higher generation and writes only activated_at.
  await client.query("select public.request_billing_reconciliation($1)", [obligationOrg]);
  const refreshLease = await claimLease(client, obligationOrg);
  await second.query("select public.request_billing_reconciliation($1)", [obligationOrg]);
  assert.equal(await writeResult(client, obligationOrg, refreshLease, "sub_stale", "past_due"), true);
  let obligationRow = await billing(client, obligationOrg);
  assert.equal(obligationRow.needs_reconciliation, true);

  await client.query("select public.request_billing_activation($1)", [obligationOrg]);
  const activationLease = await claimLease(client, obligationOrg);
  assert.equal(
    (await client.query("select public.write_activation($1,$2,$3,$4) as ok", [obligationOrg, activationLease.owner_token, activationLease.requested_generation, activationLease.activation_generation])).rows[0].ok,
    true,
  );
  obligationRow = await billing(client, obligationOrg);
  assert.ok(obligationRow.activated_at, "activation did its own work");
  assert.equal(obligationRow.status, "past_due", "activation must not have touched subscription state");
  // The pending refresh is STILL pending -- this is the assertion that
  // fails against the pre-fix shared counter.
  assert.ok(
    Number(obligationRow.billing_sync_requested) > Number(obligationRow.billing_sync_completed),
    "an activation must not mark a pending subscription refresh complete",
  );
  assert.equal(obligationRow.needs_reconciliation, true);
  pass("an activation cannot discharge a pending subscription refresh it never looked at");

  // Direction 2: a subscription refresh must not silently discharge a
  // pending activation either -- unless it obtains the evidence itself.
  const activationOrg = await org(client, "pending-activation");
  await seedCustomer(client, activationOrg);
  await client.query("select public.request_billing_activation($1)", [activationOrg]);
  const sweepLease = await claimLease(client, activationOrg);
  assert.equal(await writeResult(client, activationOrg, sweepLease, "sub_cancelled", "canceled"), true);
  let activationRow = await billing(client, activationOrg);
  assert.equal(activationRow.activated_at, null);
  assert.equal(
    activationRow.needs_reconciliation,
    true,
    "a non-active refresh leaves the pending activation outstanding",
  );
  pass("a subscription refresh cannot discharge a pending activation it never evidenced");

  // ...but an `active` status IS the evidence, so the same write settles it
  // and the organization does not livelock waiting for an invoice event that
  // may never be redelivered.
  const evidenceLease = await claimLease(client, activationOrg);
  assert.equal(await writeResult(client, activationOrg, evidenceLease, "sub_live", "active"), true);
  activationRow = await billing(client, activationOrg);
  assert.ok(activationRow.activated_at, "an active subscription evidences activation");
  assert.equal(activationRow.needs_reconciliation, false);
  pass("an `active` subscription discharges the activation obligation from evidence already held");

  // -------------------------------------------------- staleness candidates
  const missed = await org(client, "completely-missed-webhook");
  await seedCustomer(client, missed);
  await client.query(
    "update public.organization_billing set needs_reconciliation=false,reconciliation_dirty_since=null,last_synced_at=clock_timestamp()-interval '2 hours',billing_sync_last_attempt_at=clock_timestamp()-interval '2 hours' where organization_id=$1",
    [missed],
  );
  const candidates = (await client.query("select * from public.get_billing_reconciliation_candidates(200,3600)")).rows;
  assert.ok(candidates.some((r) => Number(r.organization_id) === Number(missed)));
  assert.equal(candidates.find((r) => Number(r.organization_id) === Number(missed)).stripe_customer_id, `cus_${missed}`);

  const trialOnly = await org(client, "trial-no-customer");
  assert.ok(!candidates.some((r) => Number(r.organization_id) === Number(trialOnly)));

  const leased = await org(client, "currently-leased");
  await seedCustomer(client, leased);
  await claimLease(client, leased);
  const whileLeased = (await client.query("select * from public.get_billing_reconciliation_candidates(200,1)")).rows;
  assert.ok(!whileLeased.some((r) => Number(r.organization_id) === Number(leased)));
  pass("the candidate scan finds a silently-missed webhook by staleness alone, and skips trials and live leases");

  // ------------------------------------------------- lock-wait correctness
  // A statement blocked behind SELECT FOR UPDATE must re-check the wall clock
  // AFTER it obtains that lock, never against a timestamp from before the
  // wait. No mock, and no forced final-write result.
  const delayed = await claimLease(client, syncOrg);
  await client.query("update public.organization_billing set reconciliation_lease_expires_at=clock_timestamp()+interval '0.25 seconds' where organization_id=$1", [syncOrg]);
  await third.query("begin");
  await third.query("select 1 from public.organization_billing where organization_id=$1 for update", [syncOrg]);
  const delayedWrite = writeResult(second, syncOrg, delayed, "sub_written_too_late", "canceled");
  await waitForDbLock(client, secondPid);
  await client.query("select pg_sleep(0.35)");
  await third.query("commit");
  assert.equal(await delayedWrite, false);
  pass("a reconciliation write that waits past its own lease expiry is rejected after acquiring the lock");

  // The same property for the two checkout writes that are lease-timed.
  // finish_checkout_operation and release_checkout_attempt deliberately do
  // NOT test expiry: the owner token is itself the fence (a successor's claim
  // replaces it), so letting a slightly-late owner still clean up is correct
  // rather than dangerous.
  for (const operation of ["record_checkout_session", "renew_checkout_attempt"]) {
    const lockOrg = await org(client, `wait-${operation.replace(/_/g, "")}`);
    await seedCustomer(client, lockOrg);
    const claim = await checkout(client, lockOrg);
    await client.query("update public.organization_billing set checkout_attempt_expires_at=clock_timestamp()+interval '0.25 seconds' where organization_id=$1", [lockOrg]);
    await third.query("begin");
    await third.query("select 1 from public.organization_billing where organization_id=$1 for update", [lockOrg]);
    const values = [lockOrg, claim.attempt_id, claim.owner_token];
    if (operation === "record_checkout_session") values.push("cs_late");
    const write = second.query(`select public.${operation}(${values.map((_, i) => `$${i + 1}`).join(",")}) ok`, values);
    await waitForDbLock(client, secondPid);
    await client.query("select pg_sleep(0.35)");
    await third.query("commit");
    assert.notEqual((await write).rows[0].ok, true);
  }
  pass("lease-timed checkout writes reject ownership that expires while waiting for a row lock");

  // ------------------------- R9-05: time read after EVERY lock, not some
  // A round-9 review reproduced two survivors of the now()/clock_timestamp()
  // class by holding a row lock across the deciding statement. Both are
  // pinned here the same way: block the write, let the relevant instant pass
  // while it waits, then assert the decision reflects reality.
  const alertOrg = await org(client, "alert-cooldown-lock");
  const alertLoc = (await client.query("insert into public.locations(organization_id,name) values($1,'L') returning id", [alertOrg])).rows[0].id;
  const alertCard = (await client.query("insert into public.nfc_cards(organization_id,location_id) values($1,$2) returning id", [alertOrg, alertLoc])).rows[0].id;

  await third.query("begin");
  await third.query("select 1 from public.nfc_cards where id=$1 for update", [alertCard]);
  const claimPromise = second.query("select public.claim_negative_alert_send($1,5,30) as id", [alertCard]);
  await waitForDbLock(client, secondPid);
  const beforeRelease = (await client.query("select clock_timestamp() as t")).rows[0].t;
  await client.query("select pg_sleep(1.2)");
  await third.query("commit");
  assert.ok((await claimPromise).rows[0].id, "the claim itself still succeeds");
  const reservedAt = (await client.query("select last_negative_alert_at from public.nfc_cards where id=$1", [alertCard])).rows[0].last_negative_alert_at;
  // Pre-fix this was stamped with an instant captured before the wait, so it
  // landed BEFORE the lock was even released -- shortening the real cooldown.
  assert.ok(
    reservedAt.getTime() >= beforeRelease.getTime(),
    `alert reservation was backdated to before the lock wait ended (${reservedAt.toISOString()} < ${beforeRelease.toISOString()})`,
  );
  pass("a negative-alert reservation is stamped after its card row lock, not before the wait");

  const confirmOrg = await org(client, "confirm-expiry-lock");
  // The same guard the real RPCs set -- prevent_direct_notification_email_change
  // exists precisely so this column set cannot be written without it.
  await client.query("begin");
  await client.query("select set_config('app.allow_notification_email_change','true',true)");
  await client.query(
    "update public.organizations set notification_email_pending='new@velemenytap.hu', notification_email_pending_token_hash=encode(extensions.digest('tok-r905','sha256'),'hex'), notification_email_pending_expires_at=clock_timestamp()+interval '1.5 seconds' where id=$1",
    [confirmOrg],
  );
  await client.query("commit");
  await third.query("begin");
  await third.query("select 1 from public.organizations where id=$1 for update", [confirmOrg]);
  const confirmPromise = second.query("select public.confirm_notification_email_change($1) as id", ["tok-r905"]);
  await waitForDbLock(client, secondPid);
  // Let the token genuinely expire while the call is blocked.
  await client.query("select pg_sleep(2.5)");
  await third.query("commit");
  assert.equal(
    (await confirmPromise).rows[0].id,
    null,
    "a token that expired while the call waited for the row lock must be rejected",
  );
  const stillPending = (await client.query("select notification_email, notification_email_pending from public.organizations where id=$1", [confirmOrg])).rows[0];
  assert.equal(stillPending.notification_email, null, "the expired token must not have promoted the address");
  assert.ok(stillPending.notification_email_pending, "the pending address is left for a fresh request");
  pass("a notification-email token that expires during a lock wait is rejected, not accepted");

  // --------------------------------------------- the product's own invariant
  const feedbackOrg = await org(client, "public-feedback-proof");
  const location = (
    await client.query("insert into public.locations(organization_id,name,google_review_url) values($1,'Test','https://g.page/r/audit') returning id", [feedbackOrg])
  ).rows[0].id;
  const card = (
    await client.query("insert into public.nfc_cards(organization_id,location_id) values($1,$2) returning id,public_id", [feedbackOrg, location])
  ).rows[0];
  for (let rating = 1; rating <= 5; rating++) {
    const result = (await client.query("select * from public.submit_feedback_atomic($1,$2::smallint,'audit')", [card.public_id, rating])).rows[0];
    assert.equal(result.google_review_url, "https://g.page/r/audit");
    assert.equal(Number(result.organization_id), Number(feedbackOrg));
  }
  pass("a real public submission returns the identical Google opportunity for ratings 1-5");

  await client.query(
    "update public.organization_billing set status='canceled',activated_at=clock_timestamp(),trial_ends_at=clock_timestamp()-interval '1 day' where organization_id=$1",
    [feedbackOrg],
  );
  assert.equal((await client.query("select * from public.submit_feedback_atomic($1,5::smallint,'after billing expiry')", [card.public_id])).rowCount, 1);
  pass("public feedback keeps working after the business's own subscription lapses");

  await third.query("begin");
  await third.query("update public.locations set status='inactive' where id=$1", [location]);
  const blockedSubmission = second
    .query("select * from public.submit_feedback_atomic($1,5::smallint,'must reject')", [card.public_id])
    .then(() => null, (error) => error.code);
  await waitForDbLock(client, secondPid);
  await third.query("commit");
  assert.equal(await blockedSubmission, "VT002");
  pass("a concurrent location deactivation is seen under the real submission lock");

  await client.query("update public.locations set status='active' where id=$1", [location]);
  for (let i = 6; i < 20; i++) {
    await client.query("select * from public.submit_feedback_atomic($1,3::smallint,'rate limit test')", [card.public_id]);
  }
  await assert.rejects(
    client.query("select * from public.submit_feedback_atomic($1,3::smallint,'over limit')", [card.public_id]),
    (error) => error.code === "VT003",
  );
  pass("the database rate limit rejects the 21st submission within five minutes");

  await assert.rejects(client.query("update public.feedback set rating=5 where nfc_card_id=$1", [card.id]));
  await assert.rejects(client.query("insert into public.nfc_cards(organization_id,location_id) values($1,$2)", [id, location]));
  pass("database triggers prevent feedback rating edits and cross-tenant card assignment");

  // ------------------------------------------------------- grants and RLS
  const protectedNames = [
    "claim_checkout_attempt",
    "renew_checkout_attempt",
    "record_checkout_session",
    "finish_checkout_operation",
    "release_checkout_attempt",
    "request_billing_reconciliation",
    "request_billing_activation",
    "claim_reconciliation_lease",
    "renew_reconciliation_lease",
    "write_reconciliation_result",
    "write_activation",
    "release_reconciliation_lease",
    "clear_reconciliation_dirty",
    "fail_billing_reconciliation",
    "get_billing_reconciliation_candidates",
    "record_billing_anomaly",
    "claim_stripe_customer_creation",
    "record_stripe_customer",
    "rotate_stripe_customer_creation",
  ];
  const grants = (
    await client.query(
      "select p.oid::regprocedure::text name, has_function_privilege('anon',p.oid,'execute') anon, has_function_privilege('authenticated',p.oid,'execute') authenticated, has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",
      [protectedNames],
    )
  ).rows;
  assert.equal(grants.length, protectedNames.length, `expected exactly one overload of each billing RPC, found ${grants.length}`);
  for (const grant of grants) {
    assert.equal(grant.anon, false, grant.name);
    assert.equal(grant.authenticated, false, grant.name);
    assert.equal(grant.service, true, grant.name);
  }
  pass("every billing RPC denies anon/authenticated execute and allows only service_role");

  const user = "11111111-1111-4111-8111-111111111111";
  await client.query("insert into auth.users(id) values($1)", [user]);
  await client.query("insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'owner')", [id, user]);
  await client.query("set role authenticated");
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  const visible = (await client.query("select organization_id from public.organization_billing")).rows;
  assert.deepEqual(visible.map((r) => Number(r.organization_id)), [Number(id)]);
  assert.equal((await client.query("update public.organization_billing set status='active' where organization_id=$1", [id])).rowCount, 0);
  await client.query("reset role");
  pass("an authenticated user sees only its own billing row and cannot grant itself a subscription");

  console.log(`SUCCESS ${checks} PostgreSQL checks; databases retained: ${clean.name}, ${upgrade.name}`);
} finally {
  await Promise.allSettled(connections.map((c) => c.end()));
}
