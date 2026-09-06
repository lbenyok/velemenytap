import { test, expect, type Page } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
  userClient,
  type SeededOrgMember,
} from "./support/seed";

/**
 * First-time dashboard onboarding tour. State model:
 * "not_started" (the column default -- every newly-created organization)
 * | "completed" (finished the last step) | "skipped" (Kihagyom, Escape,
 * backdrop click, or any dismissal that isn't finishing the last step).
 * Persisted server-side on organizations.onboarding_tour_status (migration
 * 20260906130000), scoped to the organization -- see that migration's own
 * comment for why organization, not user, and how existing organizations
 * are protected from seeing the tour after this feature deployed. The
 * migration performs no backfill UPDATE at all: it adds the column with
 * `default 'completed'` first (every pre-existing row reads "completed"
 * for free, as the column's own default, with no per-row write), then
 * changes the column's default to "not_started" in a second statement, so
 * only organizations created afterward get that default instead. Verified
 * directly against the isolated project's own data below.
 */

let member: SeededOrgMember;

test.afterEach(async () => {
  if (member) await cleanupOrgWithMember(member.userId, member.orgId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail cím").fill(member.email);
  await page.getByLabel("Jelszó").fill(member.password);
  await page.getByRole("button", { name: "Bejelentkezés" }).click();
  await page.waitForURL(/\/dashboard$/);
}

async function markTourStatus(orgId: number, status: "completed" | "skipped" | "not_started") {
  const admin = adminClient();
  const { error } = await admin
    .from("organizations")
    .update({ onboarding_tour_status: status })
    .eq("id", orgId);
  if (error) throw error;
}

test.describe("new organizations see the tour", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-new", "owner", "not_started");
  });

  test("a newly-created (not_started) organization shows the welcome dialog on first dashboard load", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Üdvözlünk a VéleményTapban!" })).toBeVisible();

    // The genuinely-realistic version of this same fact (a brand-new
    // organization created through the real onboarding form, never told
    // anything about this column at all, landing on the tour without any
    // test helper involved) is covered separately in
    // organization-onboarding.spec.ts's "the real onboarding form..." test.
    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("not_started");
  });

  test("the welcome dialog explains the NFC card and dashboard in plain terms, with no dashboard content hidden behind it", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByText(/NFC-kártyáiddal/)).toBeVisible();
    // The dashboard's own heading is already rendered underneath the modal
    // -- the tour is an overlay, not a gate blocking page content -- it's
    // just correctly marked inert (aria-hidden) while the modal has focus,
    // exactly what an accessible dialog should do to background content.
    // A plain CSS locator (not getByRole, which honors aria-hidden and
    // would report zero matches for genuinely inert content) is what
    // proves it's still there in the DOM, not gated behind the tour.
    await expect(page.locator("h1", { hasText: "Üdvözlünk," })).toHaveCount(1);
  });
});

test.describe("existing organizations are protected from the tour", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-existing");
    // Simulates exactly what the migration's backfill did to every
    // organization that existed before this feature shipped.
    await markTourStatus(member.orgId, "completed");
  });

  test("an organization backfilled to completed never sees the tour appear on its own", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Navigating around the dashboard afterward must not trigger it either.
    await page.getByRole("link", { name: "Helyszínek" }).click();
    await page.waitForURL(/\/dashboard\/locations$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("skip and completion both persist", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-persist", "owner", "not_started");
  });

  test("clicking Kihagyom on the welcome screen records skipped and the tour does not reappear after a reload", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Kihagyom" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("skipped");

    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("dismissing with Escape mid-tour also records skipped, not just the explicit Kihagyom button", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    await expect(page.getByRole("heading", { name: "Áttekintés" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("skipped");
  });

  test("clicking the backdrop mid-tour also records skipped, not just the explicit Kihagyom button or Escape", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    await expect(page.getByRole("heading", { name: "Áttekintés" })).toBeVisible();
    // Base UI's Dialog renders a backdrop element behind the panel -- click
    // it well outside the dialog panel's own bounds (top-left corner of the
    // viewport) so this can't accidentally land on dialog content instead.
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("skipped");
  });

  test("clicking through every step to Bezárás records completed and the tour does not reappear after a reload", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();

    const stepTitles = [
      "Áttekintés",
      "Helyszínek",
      "NFC-kártyák",
      "Vélemények",
      "Elemzés",
      "Beállítások",
      "Kezdjük is el",
    ];
    for (let i = 0; i < stepTitles.length; i++) {
      await expect(page.getByRole("heading", { name: stepTitles[i] })).toBeVisible();
      await expect(page.getByText(`${i + 1}. lépés / ${stepTitles.length}`)).toBeVisible();
      if (i < stepTitles.length - 1) {
        await page.getByRole("button", { name: "Következő" }).click();
      }
    }
    await page.getByRole("button", { name: "Bezárás" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("completed");

    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the final step's own action button also records completed and navigates to Locations", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Következő" }).click();
    }
    await expect(page.getByRole("heading", { name: "Kezdjük is el" })).toBeVisible();
    await page.getByRole("button", { name: "Helyszín hozzáadása" }).click();
    await page.waitForURL(/\/dashboard\/locations$/);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("completed");
  });

  test("Vissza is disabled on the first step and moves back to the previous step afterward", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    await expect(page.getByRole("button", { name: "Vissza" })).toBeDisabled();

    await page.getByRole("button", { name: "Következő" }).click();
    await expect(page.getByRole("heading", { name: "Helyszínek" })).toBeVisible();
    await page.getByRole("button", { name: "Vissza" }).click();
    await expect(page.getByRole("heading", { name: "Áttekintés" })).toBeVisible();
  });
});

test.describe("reopening the tour", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-reopen");
    await markTourStatus(member.orgId, "completed");
  });

  test("Útmutató megnyitása reopens the welcome dialog after completion, without re-triggering it automatically on the next visit", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Útmutató megnyitása" }).click();
    await expect(page.getByRole("heading", { name: "Üdvözlünk a VéleményTapban!" })).toBeVisible();

    // "completed" is a terminal state (see actions.ts's own state-machine
    // comment) -- dismissing a manually reopened, already-completed tour
    // must NOT downgrade it to "skipped". Checking only that the dialog
    // doesn't auto-reappear wouldn't catch a downgrade, since "skipped"
    // also never auto-opens -- the status itself has to be asserted.
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("completed");
  });

  test("the reopen button is reachable on both the desktop nav row and the mobile menu button's own header row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Útmutató megnyitása" })).toBeVisible();

    await page.setViewportSize({ width: 375, height: 720 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Útmutató megnyitása" })).toBeVisible();
  });
});

test.describe("reopening a previously-skipped tour", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-reopen-skip");
    await markTourStatus(member.orgId, "skipped");
  });

  test("dismissing a reopened, previously-skipped tour again leaves it skipped, not completed", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Útmutató megnyitása" }).click();
    await expect(page.getByRole("heading", { name: "Üdvözlünk a VéleményTapban!" })).toBeVisible();
    await page.getByRole("button", { name: "Kihagyom" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("skipped");
  });

  test("finishing a reopened, previously-skipped tour promotes it to completed", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Útmutató megnyitása" }).click();
    await page.getByRole("button", { name: "Kezdjük" }).click();
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Következő" }).click();
    }
    await page.getByRole("button", { name: "Bezárás" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("completed");
  });
});

test.describe("desktop nav highlight and mobile degradation", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-viewport", "owner", "not_started");
  });

  test("desktop (>= xl): the current step's real nav link is highlighted via its data-tour attribute", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    await page.getByRole("button", { name: "Következő" }).click(); // -> Helyszínek step

    const target = page.locator('nav[aria-label="Irányítópult navigáció"] [data-tour="nav-locations"]');
    await expect(target).toHaveClass(/tour-highlight/);

    // Moving on removes the highlight from the previous step's target
    // rather than leaving it stuck.
    await page.getByRole("button", { name: "Következő" }).click(); // -> NFC-kártyák step
    await expect(target).not.toHaveClass(/tour-highlight/);
  });

  test("below xl: the desktop nav link doesn't exist as a visible element, so the tour renders the same step as a plain dialog instead of pointing at nothing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await signIn(page);

    // The exact R4-06 assertion this project already uses elsewhere: below
    // xl, the inline nav link is not present as a visible element at all.
    await expect(page.getByRole("link", { name: "Helyszínek" })).toHaveCount(0);

    await page.getByRole("button", { name: "Kezdjük" }).click();
    await page.getByRole("button", { name: "Következő" }).click();
    // The step itself still renders correctly -- title, body, and controls
    // all present and operable -- with nothing pointing at an invisible
    // element.
    await expect(page.getByRole("heading", { name: "Helyszínek" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Következő" })).toBeVisible();
  });

  test("the dashboard's own mobile menu opens normally once the tour is dismissed, with no leftover overlay interference", async ({
    page,
  }) => {
    // Note: this deliberately dismisses the tour FIRST -- a modal dialog is
    // supposed to trap focus and block the page underneath it, so "the menu
    // opens while the tour dialog is still genuinely open" is not something
    // to assert; that would be testing that the dialog fails to behave like
    // a dialog. What this actually guards against is a dismissed tour
    // leaving some stray overlay/aria-hidden/focus-trap state behind that
    // interferes with normal navigation afterward.
    await page.setViewportSize({ width: 375, height: 720 });
    await signIn(page);
    await page.getByRole("button", { name: "Kihagyom" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Menü megnyitása" }).click();
    await expect(
      page.getByRole("navigation", { name: "Irányítópult navigáció" }).getByRole("link", { name: "Helyszínek" }),
    ).toBeVisible();
  });
});

test.describe("resilience", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-resilience", "owner", "not_started");
  });

  test("core dashboard content renders and is usable even while client JS is still loading", async ({ page }) => {
    // Delays every Next.js client chunk -- simulates "JavaScript is slow"
    // without needing to fake a specific network condition API. The
    // server-rendered dashboard content must not be gated behind the
    // tour's own client-side hydration.
    await page.route("**/_next/static/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    await page.goto("/login");
    await page.getByLabel("E-mail cím").fill(member.email);
    await page.getByLabel("Jelszó").fill(member.password);
    await page.getByRole("button", { name: "Bejelentkezés" }).click();
    await page.waitForURL(/\/dashboard$/);

    // Server-rendered heading, present and visible immediately from SSR --
    // does not wait on the tour's own client bundle to finish loading.
    await expect(page.getByRole("heading", { name: /Üdvözlünk,/ })).toBeVisible({ timeout: 3000 });
  });

  test("a step whose data-tour target is missing from the DOM entirely does not break the tour or the page", async ({
    page,
  }) => {
    await signIn(page);
    // Removes a target the tour is about to look for, simulating "target
    // temporarily unavailable" more strongly than viewport hiding does --
    // the element genuinely isn't there at all when the tour looks for it.
    await page.evaluate(() => {
      document.querySelector('[data-tour="nav-nfc-cards"]')?.remove();
    });
    await page.getByRole("button", { name: "Kezdjük" }).click();
    await page.getByRole("button", { name: "Következő" }).click();
    await page.getByRole("button", { name: "Következő" }).click();
    // The NFC-kártyák step itself must still render normally.
    await expect(page.getByRole("heading", { name: "NFC-kártyák" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Következő" })).toBeEnabled();
  });
});

test.describe("a failed save is never silently discarded", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-fail", "owner", "not_started");
  });

  /** Aborts only the Server Action's own POST (to the dashboard page itself)
   * -- a genuine network failure, not the function body returning `{ error
   * }` -- while leaving every other request (the initial page load, static
   * assets) alone. */
  async function breakTourPersistence(page: Page) {
    await page.route("**/dashboard", async (route) => {
      if (route.request().method() === "POST") {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
  }

  test("a network failure while dismissing the tour shows a retry prompt, and a successful retry then persists it", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await breakTourPersistence(page);

    await page.getByRole("button", { name: "Kihagyom" }).click();
    // Stays open with an explicit failure state -- not silently closed as
    // if the write had succeeded.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();

    const admin = adminClient();
    const { data: whileFailing } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(whileFailing?.onboarding_tour_status).toBe("not_started");

    await page.unroute("**/dashboard");
    await page.getByRole("button", { name: "Próbáld újra" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const { data: afterRetry } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(afterRetry?.onboarding_tour_status).toBe("skipped");
  });

  test("'Bezárás mentés nélkül' after a failed save closes the dialog without ever persisting the attempted status", async ({
    page,
  }) => {
    await signIn(page);
    await breakTourPersistence(page);

    await page.getByRole("button", { name: "Kihagyom" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Bezárás mentés nélkül" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    // Deliberately unchanged -- "close anyway" is an informed choice not to
    // persist, not a silent write of whatever was being attempted.
    expect(data?.onboarding_tour_status).toBe("not_started");
  });

  test("a network failure on the final step's own action button, followed by a successful retry, still navigates to Locations exactly once", async ({
    page,
  }) => {
    // Found during an independent review: the first attempt's own
    // navigation intent ("Helyszín hozzáadása" -> /dashboard/locations) was
    // only ever acted on by the button's own click handler, awaiting that
    // ONE call -- a failed attempt followed by a successful "Próbáld újra"
    // (which re-enters through the provider's own retry(), never back
    // through the button) persisted "completed" correctly but silently
    // dropped the navigation. Fixed by carrying the intended destination
    // inside the pending-close state itself, so whichever attempt actually
    // succeeds -- first try or a later retry -- is the one that navigates.
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Következő" }).click();
    }
    await expect(page.getByRole("heading", { name: "Kezdjük is el" })).toBeVisible();

    await breakTourPersistence(page);
    await page.getByRole("button", { name: "Helyszín hozzáadása" }).click();

    // The retry UI appears and navigation has NOT happened -- the failed
    // first attempt must not leave the user on /dashboard/locations with
    // an unconfirmed write, nor silently strand them with no way forward.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Próbáld újra" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/dashboard");

    const admin = adminClient();
    const { data: whileFailing } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(whileFailing?.onboarding_tour_status).toBe("not_started");

    await page.unroute("**/dashboard");
    await page.getByRole("button", { name: "Próbáld újra" }).click();

    // Exactly one navigation: attemptClose (in the provider) has exactly
    // one `router.push` call site, reached only from the single successful
    // resolution of this one retry -- there is no second path that could
    // fire it again.
    await page.waitForURL(/\/dashboard\/locations$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const { data: afterRetry } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(afterRetry?.onboarding_tour_status).toBe("completed");
  });

  test("a network failure on the ordinary Bezárás button (not the action button), followed by a successful retry, does not navigate anywhere", async ({
    page,
  }) => {
    // The mirror case: only the action-button-originated attempt should
    // ever navigate. Reaching the same final step through the plain
    // Bezárás button instead must never pick up a stray navigation, on the
    // first attempt or after a retry.
    await signIn(page);
    await page.getByRole("button", { name: "Kezdjük" }).click();
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Következő" }).click();
    }
    await expect(page.getByRole("heading", { name: "Kezdjük is el" })).toBeVisible();

    await breakTourPersistence(page);
    await page.getByRole("button", { name: "Bezárás" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await page.unroute("**/dashboard");
    await page.getByRole("button", { name: "Próbáld újra" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(new URL(page.url()).pathname).toBe("/dashboard");

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("completed");
  });
});

test.describe("setOnboardingTourStatusAction's zero-affected-row disambiguation", () => {
  // Found during an independent review: the UPDATE's own affected-row count
  // being zero is ambiguous by itself -- the action previously treated it as
  // success unconditionally, on the assumption that the only way to get
  // zero rows is the WHERE clause's own "already completed" guard. That's
  // not the only way: a membership that no longer permits the write (RLS)
  // also produces zero affected rows, and is a real failure, not a no-op.
  // actions.ts now reads the row back through the same RLS-bound client
  // before deciding, and these three tests cover the disambiguation's own
  // three outcomes directly, on top of the many other tests in this file
  // that already exercise ordinary single-row success incidentally.
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-zero-row", "owner", "not_started");
  });

  test("a normal update affecting exactly one row succeeds and persists the new status", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Kihagyom" }).click();
    // The dialog closing at all (not staying open on a PendingCloseBanner)
    // is itself proof no error banner appeared -- the ordinary,
    // single-row-affected success path. (Not a separate `getByRole("alert")`
    // check: Next.js's own accessibility route-announcer also carries
    // `role="alert"` on every page, unrelated to the tour.)
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("skipped");
  });

  test("a zero-row result because another session already completed it concurrently is treated as success, not an error", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();

    // Simulates a different device/tab completing the tour after this
    // page loaded (this client's own lastKnownStatusRef is still stale at
    // "not_started", so it can't take its own client-side shortcut and
    // must actually call the Server Action) -- the UPDATE's `<> 'completed'`
    // guard blocks the write, affecting zero rows, purely because the
    // organization already reads "completed".
    const admin = adminClient();
    await admin.from("organizations").update({ onboarding_tour_status: "completed" }).eq("id", member.orgId);

    await page.getByRole("button", { name: "Kihagyom" }).click();
    // The disambiguating read-back confirmed the row is genuinely
    // "completed" -- the dialog closing at all is what proves this was
    // reported as success, not a retry prompt.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    // Unchanged, and NOT downgraded to "skipped" -- "completed" stays
    // terminal regardless of which path confirmed it.
    expect(data?.onboarding_tour_status).toBe("completed");
  });

  test("a zero-row result because the organization is no longer accessible returns a real error, not success", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole("dialog")).toBeVisible();

    // Removes this user's membership entirely before they act -- the most
    // realistic real-world trigger for "the row this session could act on
    // a moment ago is no longer readable or writable," which is the same
    // failure category the disambiguation's "unreadable" branch exists
    // for. (The exact single-function-call race the review describes --
    // membership vanishing between the action's own organization lookup
    // and its UPDATE call, microseconds apart -- has no black-box hook to
    // trigger from an e2e test; this reaches the action's earlier
    // "no organization" guard rather than the UPDATE's own zero-row branch
    // specifically, but proves the same required outcome: persistence
    // that didn't happen is never reported as success.)
    const admin = adminClient();
    await admin.from("organization_memberships").delete().eq("organization_id", member.orgId).eq("user_id", member.userId);

    await page.getByRole("button", { name: "Kihagyom" }).click();
    // Stays open with a real error -- not silently closed as if the tour's
    // dismissal had been recorded.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();

    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("not_started");

    // Restore the membership so afterEach's cleanup (which deletes by
    // organization_id, not through this now-orphaned membership row) can
    // still tear down normally -- already safe either way, but explicit.
    await admin.from("organization_memberships").insert({
      organization_id: member.orgId,
      user_id: member.userId,
      role: "owner",
    });
  });
});

test.describe("database-level enforcement, independent of the Server Action's own validation", () => {
  test.beforeEach(async () => {
    member = await seedOrgWithMember("tour-check-constraint", "owner", "not_started");
  });

  test("a forged/invalid status value is rejected by the column's CHECK constraint even when the Server Action itself is bypassed entirely", async () => {
    // setOnboardingTourStatusAction's own `status !== "completed" &&
    // status !== "skipped"` guard is application-level and only protects
    // calls that actually reach it -- but a raw POST to the action's own
    // endpoint id still invokes the real function body, guard included; it
    // does NOT skip that check the way this test's name might suggest. What
    // this test actually does is go around the Server Action entirely,
    // writing straight through the same RLS-bound client the action itself
    // uses (`supabase.from("organizations").update(...)`, no action call at
    // all) -- proving the CHECK constraint holds even for a write that
    // never passes through the action's own validation in the first place,
    // which is the more thorough thing to demonstrate: it doesn't depend on
    // finding an actual way to defeat the action's runtime check, only on
    // the database not trusting the application layer to be the only path
    // to this column.
    const client = await userClient(member.email, member.password);
    // Deliberately cast past the generated column type -- the whole point
    // is to prove the database itself rejects a value TypeScript alone
    // would never let this call send.
    const { error } = await client
      .from("organizations")
      .update({ onboarding_tour_status: "hacked" as never })
      .eq("id", member.orgId);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/onboarding_tour_status/i);

    const admin = adminClient();
    const { data } = await admin
      .from("organizations")
      .select("onboarding_tour_status")
      .eq("id", member.orgId)
      .single();
    expect(data?.onboarding_tour_status).toBe("not_started");
  });
});
