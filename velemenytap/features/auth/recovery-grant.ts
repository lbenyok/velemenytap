import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Permission to set a new password without knowing the old one.
 *
 * **Round-14 R14-01 (P1).** The first version of this file was a cookie whose
 * only check was that it existed. That is not a permission, it is a request
 * header: `HttpOnly` restricts what scripts may READ from the browser's jar and
 * says nothing about the authenticity of a Cookie line arriving at the server,
 * and the request does not carry those attributes back as proof. The attacker
 * the guard was written to stop -- someone in control of an already-signed-in
 * browser -- is by definition someone who can send
 * `pw_recovery_grant=anything`. So the check supplied no authorization at all
 * against the only threat it named. My bug, found by the round-14 reviewer the
 * day after I shipped it.
 *
 * What replaced it. The cookie now carries a random 32-byte token and is
 * nothing but a lookup key; the authority is a row in
 * `public.password_recovery_grants`, of which the server stores only the
 * token's SHA-256. Consuming one requires the caller's own verified user id to
 * match the row's, an unexpired `expires_at` judged by the database clock, and
 * an unconsumed row -- and consumption is an atomic conditional UPDATE behind
 * a row lock, so two concurrent replays of the same token cannot both win.
 *
 * What is deliberately NOT trusted:
 *
 *   * the cookie's value, beyond being a key to look up;
 *   * `maxAge`, which is the browser's business -- expiry is checked server-side;
 *   * the request's routing (`next=/auth/reset-password`), which is
 *     caller-controlled data and not evidence of how anyone authenticated. A
 *     grant is issued only where a recovery OTP has actually been verified.
 */
const RECOVERY_GRANT_COOKIE = "pw_recovery_grant";

/**
 * Short on purpose: it has to survive the redirect from the email link to the
 * form and the time taken to type a password, not a session. A recovery link
 * left open in a tab overnight should ask for the current password like any
 * other stale session.
 */
const RECOVERY_GRANT_SECONDS = 15 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issued only where a recovery OTP has actually been verified against Supabase
 * -- never on routing alone, and never on a code exchange whose type this
 * application cannot establish.
 */
export async function grantRecoveryPasswordChange(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");

  // Recorded server-side BEFORE the cookie is set. A cookie whose row failed
  // to write is simply a key that resolves to nothing, which fails closed; the
  // reverse order would briefly leave a row a client could not present.
  const admin = createAdminClient();
  const { error } = await admin.rpc("issue_password_recovery_grant", {
    p_user_id: userId,
    p_token_hash: hashToken(token),
    p_ttl_seconds: RECOVERY_GRANT_SECONDS,
  });
  if (error) throw new Error("Nem sikerült előkészíteni a jelszó-visszaállítást.");

  const store = await cookies();
  store.set(RECOVERY_GRANT_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: RECOVERY_GRANT_SECONDS,
    path: "/auth",
  });
}

/**
 * Read-only, for deciding whether to RENDER the current-password field. A page
 * load is not a password change, so this must not consume the grant -- a user
 * who reloads the form before submitting would otherwise lose it.
 *
 * This is a rendering hint and never an authorization decision. The Server
 * Action calls `consumeRecoveryPasswordGrant` and believes only that.
 */
export async function hasRecoveryPasswordGrant(userId: string): Promise<boolean> {
  const store = await cookies();
  const token = store.get(RECOVERY_GRANT_COOKIE)?.value;
  if (!token) return false;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("password_recovery_grant_is_valid", {
    p_user_id: userId,
    p_token_hash: hashToken(token),
  });
  return !error && data === true;
}

/**
 * The authorization decision, and the only one. Returns true at most once per
 * grant: the database consumes the row inside the same locked statement that
 * validates it, so a replayed cookie -- concurrent or not -- gets false.
 */
export async function consumeRecoveryPasswordGrant(userId: string): Promise<boolean> {
  const store = await cookies();
  const token = store.get(RECOVERY_GRANT_COOKIE)?.value;
  if (!token) return false;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("consume_password_recovery_grant", {
    p_user_id: userId,
    p_token_hash: hashToken(token),
  });
  const consumed = !error && data === true;

  // The cookie is cleared either way. It is only ever a key, and once the row
  // behind it is spent -- or was never valid -- keeping it around invites
  // exactly the "is this cookie itself the permission?" confusion that caused
  // R14-01.
  await clearRecoveryPasswordGrant();
  return consumed;
}

/**
 * Round-15 R15-02. A grant is consumed BEFORE the provider is called, because
 * consumption is what makes it single-use under concurrency. But the provider
 * can still refuse the new password on its own policy -- too weak, previously
 * leaked -- and the error text invites the customer to pick a different one.
 * With the grant already spent, that retry asked for the password they had
 * forgotten, which is the whole reason they were in recovery.
 *
 * The repair is deliberately NOT "un-spend the old token": restoring
 * `consumed_at` to null would make a token replayable after an update whose
 * outcome we may not actually know. A brand-new grant is issued instead --
 * fresh token, fresh row, the spent one still dead -- so the customer can
 * retry in place while replay protection is untouched.
 *
 * Only for rejections where the provider has definitively NOT changed the
 * password. An ambiguous failure must leave the grant spent.
 */
export async function reissueRecoveryPasswordGrant(userId: string): Promise<void> {
  await grantRecoveryPasswordChange(userId);
}

export async function clearRecoveryPasswordGrant(): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_GRANT_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/auth",
  });
}

/**
 * Exported for the unit tests only: proves the stored value is a hash rather
 * than the token itself, without the test reaching into node:crypto and
 * re-implementing the thing under test.
 */
export function tokenHashForTest(token: string): string {
  return hashToken(token);
}
