import { test, expect } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  generateRecoveryToken,
  signInOutcome,
  type SeededOrgMember,
} from "./support/seed";
import { signInViaUi } from "./support/ui";

/**
 * `/auth/reset-password` and `updatePasswordAction` ship with this branch and
 * have never been reviewed adversarially. Neither exists on `master`, so
 * nothing here is live — which is the best possible time to find this.
 *
 * The page's only gate is "is there a session". It does not check that the
 * session came from a recovery link, and `updatePasswordAction` never asks for
 * the current password. So anyone sitting at an already-signed-in browser can
 * set a new password, in two clicks, with no email and no knowledge of the old
 * one — locking the owner out of their own account and keeping access.
 *
 * That is not a contrived threat for this product. The customer is a café,
 * salon or clinic; the dashboard lives on a laptop behind the counter with
 * staff and strangers around it. An unattended signed-in browser is the normal
 * case, not the exception.
 *
 * The fix must keep genuine recovery working: someone who has forgotten their
 * password cannot be asked for it. So the two paths are distinguished rather
 * than merged — a recovery link grants a short-lived, server-set marker, and
 * any other session must prove it knows the current password.
 */

let member: SeededOrgMember;

test.beforeEach(async () => {
  member = await seedOrgWithMember("pw-session-riding");
});

test.afterEach(async () => {
  await cleanupOrgWithMember(member.userId, member.orgId);
});

test("an ordinary signed-in session cannot change the password without the current one", async ({
  page,
}) => {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL("/dashboard");

  // Straight to the reset page, with no recovery email anywhere in the story.
  await page.goto("/auth/reset-password");
  await expect(page.getByRole("heading", { name: "Adj meg új jelszót" })).toBeVisible();

  // The field is there and the browser will not submit without it -- but that
  // is UX, not a boundary, so it is asserted and then deliberately defeated.
  const currentPassword = page.getByLabel("Jelenlegi jelszó");
  await expect(currentPassword).toBeVisible();
  await expect(currentPassword).toHaveAttribute("required", "");

  const attackerPassword = `Attacker-${Date.now()}!`;
  await page.getByLabel("Új jelszó", { exact: true }).fill(attackerPassword);
  await page.getByLabel("Új jelszó még egyszer").fill(attackerPassword);

  // An attacker does not fill in the form politely. Stripping `required` is
  // the cheapest possible stand-in for posting the action directly, and it is
  // what makes this a test of the SERVER's refusal rather than of an
  // attribute anyone can delete from the devtools console.
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>("#current_password")?.removeAttribute("required");
  });
  await page.getByRole("button", { name: "Új jelszó mentése" }).click();

  // Scoped to the form's own error node: Next.js ships a route announcer with
  // role="alert" on every page, so getByRole("alert") is ambiguous here.
  // Exact, and scoped to the form's own error node. The page description
  // contains the same words ("A biztonság kedvéért add meg a jelenlegi
  // jelszavad is.") and Playwright's getByText is a case-insensitive substring
  // match, so the loose version matched text that is on the page BEFORE any
  // submit -- it passed against the unfixed code it exists to catch.
  await expect(
    page.getByText("Add meg a jelenlegi jelszavad is, vagy kérj jelszó-visszaállító e-mailt.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });

  // The assertion that actually matters: the account still belongs to its
  // owner. A UI error message that did not prevent the write would be worse
  // than no message at all.
  expect(
    await signInOutcome(member.email, attackerPassword),
    "the attacker's password works — the account was taken over",
  ).toBe("rejected");
  expect(await signInOutcome(member.email, member.password)).toBe("accepted");
});

test("the current password still lets a signed-in user change their own password", async ({
  page,
}) => {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL("/dashboard");
  await page.goto("/auth/reset-password");

  const newPassword = `Chosen-${Date.now()}!`;
  await page.getByLabel("Jelenlegi jelszó").fill(member.password);
  await page.getByLabel("Új jelszó", { exact: true }).fill(newPassword);
  await page.getByLabel("Új jelszó még egyszer").fill(newPassword);
  await page.getByRole("button", { name: "Új jelszó mentése" }).click();

  await expect(page.getByText("Az új jelszavadat elmentettük.")).toBeVisible({ timeout: 10_000 });

  expect(await signInOutcome(member.email, newPassword)).toBe("accepted");
});

test("a wrong current password changes nothing", async ({ page }) => {
  await signInViaUi(page, member.email, member.password);
  await page.waitForURL("/dashboard");
  await page.goto("/auth/reset-password");

  const attempted = `Wrong-${Date.now()}!`;
  await page.getByLabel("Jelenlegi jelszó").fill("not-the-current-password");
  await page.getByLabel("Új jelszó", { exact: true }).fill(attempted);
  await page.getByLabel("Új jelszó még egyszer").fill(attempted);
  await page.getByRole("button", { name: "Új jelszó mentése" }).click();

  await expect(page.getByText("A megadott jelenlegi jelszó nem helyes.")).toBeVisible({ timeout: 15_000 });

  expect(await signInOutcome(member.email, attempted)).toBe("rejected");
  expect(await signInOutcome(member.email, member.password)).toBe("accepted");
});

/**
 * The other half, and the one this fix could plausibly break: someone who has
 * genuinely forgotten their password must still be able to set a new one
 * WITHOUT being asked for the old one. A security fix that quietly disables
 * account recovery is not a fix.
 */
test("a genuine recovery link still sets a new password with no current password", async ({
  page,
}) => {
  const { tokenHash } = await generateRecoveryToken(member.email);

  // Exactly the shape the production Reset-password template produces
  // (LAUNCH_CHECKLIST.md § 1), consumed by the real route.
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery&next=/auth/reset-password`);
  await expect(page.getByRole("heading", { name: "Adj meg új jelszót" })).toBeVisible();

  // No current-password field at all: this session proved itself with a token
  // from the account owner's inbox.
  await expect(page.getByLabel("Jelenlegi jelszó")).toHaveCount(0);

  const recovered = `Recovered-${Date.now()}!`;
  await page.getByLabel("Új jelszó", { exact: true }).fill(recovered);
  await page.getByLabel("Új jelszó még egyszer").fill(recovered);
  await page.getByRole("button", { name: "Új jelszó mentése" }).click();

  await expect(page.getByText("Az új jelszavadat elmentettük.")).toBeVisible({ timeout: 15_000 });

  expect(await signInOutcome(member.email, recovered)).toBe("accepted");

  // And the grant is spent: reloading the page asks for the current password
  // again, so one recovery email buys exactly one password change rather than
  // a standing permission on this browser for the rest of the window.
  await page.goto("/auth/reset-password");
  await expect(page.getByLabel("Jelenlegi jelszó")).toBeVisible();
});
