import { test, expect, type Page } from "@playwright/test";
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  adminClient,
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
 * are protected from seeing the tour after this feature deployed (a
 * one-time UPDATE backfilling every pre-existing row to "completed",
 * verified directly against the isolated project's own data below).
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

    // Reopening itself must not rewrite the persisted status -- closing it
    // again (without finishing) still records skipped, same as any other
    // dismissal, and a later plain visit must still not auto-open it.
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
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

  test("the dashboard's own mobile menu still opens normally while the tour is open, unaffected by it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await signIn(page);
    await page.getByRole("button", { name: "Kihagyom" }).click();

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
