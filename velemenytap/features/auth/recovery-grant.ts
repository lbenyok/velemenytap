import "server-only";

import { cookies } from "next/headers";

/**
 * The marker that says "this session arrived through a password-recovery email
 * a few minutes ago", and is therefore allowed to set a new password without
 * knowing the old one.
 *
 * Why this exists. `/auth/reset-password` used to gate on nothing but "is
 * there a session", and `updatePasswordAction` never asked for the current
 * password. Anyone sitting at an already-signed-in browser could set a new
 * password in two clicks — no email, no knowledge of the old one — which both
 * locks the owner out and keeps the attacker in. Reproduced end to end before
 * this was written (`e2e/password-change-session-riding.spec.ts`): the new
 * password worked and the owner's stopped working.
 *
 * The obvious fix — always demand the current password — breaks the one flow
 * that cannot supply it, which is the entire point of recovery. So the two
 * cases are distinguished instead of merged, and this is the distinction.
 *
 * Why a server-set cookie rather than reading the session's own claims: the
 * shape of Supabase's `amr`/`aal` claims for a recovery sign-in is not part of
 * any contract this project controls, and a guess there would be a security
 * decision resting on an undocumented field. This grant is issued by this
 * application, at exactly one moment it can prove (a recovery link whose OTP
 * or PKCE exchange just succeeded), and it cannot be forged from the browser:
 * it is HttpOnly, so no script sets it, and the only route that issues it
 * requires a token that arrived in the account owner's own inbox.
 */
const RECOVERY_GRANT_COOKIE = "pw_recovery_grant";

/**
 * Short on purpose. It only has to survive the redirect from the email link to
 * the form and the time taken to type a password — not a session. A recovery
 * link left open in a tab overnight should ask for the current password like
 * any other stale session would.
 */
const RECOVERY_GRANT_SECONDS = 15 * 60;

/** Issued only after a recovery link's own exchange has actually succeeded. */
export async function grantRecoveryPasswordChange(): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_GRANT_COOKIE, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: RECOVERY_GRANT_SECONDS,
    path: "/auth",
  });
}

export async function hasRecoveryPasswordGrant(): Promise<boolean> {
  const store = await cookies();
  return store.get(RECOVERY_GRANT_COOKIE) !== undefined;
}

/**
 * One password change per recovery email. Clearing it on use means a recovery
 * link cannot be spent once and then left behind as a standing permission on
 * that browser for the rest of the window.
 */
export async function clearRecoveryPasswordGrant(): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_GRANT_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: "/auth" });
}
