// Round-15 R15-01. Answers one question about a Supabase project, by measuring
// rather than by reading a dashboard:
//
//   Can an ordinary signed-in session change its own password through the Auth
//   API, without supplying the current one?
//
// This matters because the application's own guard (features/auth/recovery-
// grant.ts + updatePasswordAction) is enforced in a Server Action, and an
// attacker sitting at a signed-in browser is under no obligation to use it.
// They hold the session; they can call the Auth API directly. So the real
// boundary is the project's "Require current password when changing password"
// setting, and this script reports whether it is actually on.
//
// Measured against the isolated project on 2026-09-14: the bypass SUCCEEDED --
// the new password worked and the old one stopped. That is the state this
// script exists to detect, and the launch gate in LAUNCH_CHECKLIST.md § 1
// exists to close.
//
// NOTE ON "Secure password change": that is a DIFFERENT option, and it is not
// sufficient on its own. Supabase documents it as exempting sessions created in
// the last 24 hours -- and the unattended-browser session this threat model is
// about is exactly such a session.
//
// Usage:
//   node scripts/check-password-change-enforcement.mjs
// Reads NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY /
// SUPABASE_SECRET_KEY from the environment, or from .env.test.local.
//
// Creates one throwaway user and deletes it again. Never run it against a
// project where creating a user is not acceptable.

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function config(key) {
  if (process.env[key]) return process.env[key];
  const file = ".env.test.local";
  if (!existsSync(file)) throw new Error(`${key} is not set and ${file} does not exist`);
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} is not set and ${file} does not contain it`);
  return line.slice(key.length + 1).replace(/^["']|["']$/g, "");
}

const url = config("NEXT_PUBLIC_SUPABASE_URL");
const publishable = config("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const secret = config("SUPABASE_SECRET_KEY");

const admin = createClient(url, secret, { auth: { persistSession: false } });
const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `pwcheck-${unique}@example.com`;
const original = `Original-${unique}!`;
const attacker = `Bypassed-${unique}!`;

console.log(`Project: ${url}`);
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email,
  password: original,
  email_confirm: true,
});
if (createError) throw createError;

let enforced = false;
try {
  const session = createClient(url, publishable, { auth: { persistSession: false } });
  const { error: signInError } = await session.auth.signInWithPassword({ email, password: original });
  if (signInError) throw signInError;

  // The bypass: an ordinary session, no current password, no Server Action.
  const { error: updateError } = await session.auth.updateUser({ password: attacker });

  const withNew = await createClient(url, publishable, { auth: { persistSession: false } }).auth.signInWithPassword({
    email,
    password: attacker,
  });

  enforced = Boolean(updateError) && Boolean(withNew.error);

  console.log(`  direct updateUser({password}) -> ${updateError ? `refused: ${updateError.message}` : "ACCEPTED"}`);
  console.log(`  attacker's password works     -> ${withNew.error ? "no" : "YES"}`);
  console.log("");
  console.log(
    enforced
      ? "PASS: the provider refuses a password change that carries no current password.\n" +
          "      The application guard and the provider agree."
      : "FAIL: an ordinary session changed its own password through the Auth API.\n" +
          "      The application's guard is a UI-path defence only -- anyone holding this\n" +
          "      session can bypass it. Enable 'Require current password when changing\n" +
          "      password' for this project (Authentication -> Providers -> Email), then\n" +
          "      re-run. See LAUNCH_CHECKLIST.md § 1 and SECURITY.md.",
  );
} finally {
  await admin.auth.admin.deleteUser(created.user.id);
  console.log("\n(throwaway user deleted)");
}

process.exit(enforced ? 0 : 1);
