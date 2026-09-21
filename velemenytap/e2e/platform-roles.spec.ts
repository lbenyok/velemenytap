import { test, expect } from "@playwright/test";
import { adminClient, seedOrgWithMember, cleanupOrgWithMember, seedActiveCard } from "./support/seed";
import { signInViaUi } from "./support/ui";

test("owner grants and revokes a moderator; restricted UI and stale-session enforcement", async ({ page, browser }) => {
  test.setTimeout(180000);
  const owner=await seedOrgWithMember("role-owner");
  const moderator=await seedOrgWithMember("role-moderator");
  const customer=await seedOrgWithMember("role-customer");
  const admin=adminClient();
  const modContext=await browser.newContext();
  try {
    expect((await admin.from("platform_admins").insert({ user_id:owner.userId, role:"owner" })).error).toBeNull();
    const card=await seedActiveCard(customer.orgId,"moderator-card");
    await signInViaUi(page,owner.email,owner.password,"/admin?view=team");
    await page.getByLabel("Új moderátor e-mail-címe").fill(moderator.email);
    await page.getByRole("button",{name:"Moderátor hozzáadása",exact:true}).click();
    await expect(page.getByRole("button",{name:"Hozzáférés visszavonása",exact:true})).toBeVisible();
    expect((await admin.from("platform_admins").select("role").eq("user_id",moderator.userId).single()).data?.role).toBe("moderator");
    const modPage=await modContext.newPage();
    await signInViaUi(modPage,moderator.email,moderator.password,`/admin?org=${customer.orgId}`);
    await expect(modPage.getByRole("heading",{name:"Moderátori admin",exact:true})).toBeVisible();
    await expect(modPage.getByRole("link",{name:"Csapat és jogosultságok",exact:true})).toHaveCount(0);
    await expect(modPage.getByLabel("Nemfizetés kezelése")).toHaveCount(0);
    await expect(modPage.getByRole("button",{name:"Fizetési mód mentése",exact:true})).toHaveCount(0);
    const item=modPage.getByRole("article").filter({hasText:card.publicId});
    await item.getByRole("textbox",{name:"Indoklás"}).fill("Moderátor által ellenőrzött elveszett kártya");
    await item.getByRole("button",{name:"Kártya zárolása",exact:true}).click();
    await expect(item.getByText("Kézzel zárolva",{exact:true})).toBeVisible();
    await modPage.getByRole("link",{name:"Fizetések",exact:true}).click();
    await expect(modPage.getByRole("heading",{name:"Előfizetések és fizetési állapot",exact:true})).toBeVisible();
    await modPage.goto(`/admin?org=${customer.orgId}`);
    await page.getByRole("button",{name:"Hozzáférés visszavonása",exact:true}).click();
    await expect(page.getByRole("button",{name:"Hozzáférés visszavonása",exact:true})).toHaveCount(0);
    // Submit the still-open moderator form after revocation.
    await item.getByRole("textbox",{name:"Indoklás"}).fill("Stale revoked session");
    await item.getByRole("button",{name:"Zárolás feloldása",exact:true}).click();
    await expect(modPage.getByText("Nincs platform-adminisztrátori jogosultságod.",{exact:true})).toBeVisible();
    expect((await admin.from("nfc_cards").select("platform_locked").eq("id",card.cardId).single()).data?.platform_locked).toBe(true);
    await modPage.goto("/admin?view=team");
    await expect(modPage.getByRole("heading",{name:"Csapat és jogosultságok",exact:true})).toHaveCount(0);
    await page.goto("/admin");
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:"../../../outputs/admin-console-desktop.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:"../../../outputs/admin-console-mobile.png",fullPage:true});
  } finally {
    await modContext.close();
    await admin.from("platform_card_audit").delete().eq("organization_id",customer.orgId);
    await cleanupOrgWithMember(customer.userId,customer.orgId);
    await cleanupOrgWithMember(moderator.userId,moderator.orgId);
    await cleanupOrgWithMember(owner.userId,owner.orgId);
  }
});
