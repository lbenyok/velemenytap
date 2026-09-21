# Fizetésfigyelő és kártyatiltás

Az adminpanel vállalkozásonként kézi vagy automatikus módot kínál. Az alapérték kézi mód és 3 nap türelmi idő. Az automatikus módra váltás már lejárt türelmi időnél azonnal tilthat; ezt a felület előre jelzi. A kézi mód megszünteti a fizetési tiltást, de nem old fel egyedi kézi kártyazárolást.

## Adat és végrehajtás

- A meglévő Stripe-egyeztetés marad a jogosultság forrása. Az új értékelő az előfizetési állapotot, az egyszeri próbaidőt és a korábbi hozzáférési jogot figyelembe veszi, de nem módosítja az aktiválási vagy egyeztetési számlálókat.
- `billing_card_controls` kezeli a vállalkozás egészére vonatkozó fizetési tiltást. A kártya `status`, `platform_locked` és `platform_previous_status` mezőit nem írja. Új szervezet létrehozásakor automatikusan létrejön a vezérlőrekord.
- A publikus lekérdezés ellenőrzi a tiltást. Egy külön, adatbázisbeli `BEFORE INSERT` trigger a korábban megnyitott űrlapból vagy közvetlen szolgáltatói hívással érkező beküldést is ellenőrzi, közös sorzárral.
- Az értékelés zárolási sorrendje: számlázási sor megosztott zárolása → vezérlősor kizáró zárolása → értesítés. Nem zárol kártyát vagy helyszínt. A visszajelzés meglévő kártya → helyszín → szervezet sorrendje után kér megosztott vezérlőzárat. A döntési időt az értékelő a zárolások után olvassa.
- Hiányzó, piszkos, hibás vagy 2 óránál régebben szinkronizált Stripe-állapotból nincs új tiltás és nincs automatikus feloldás. Az előző tiltás megmarad, az állapot `unknown`. A türelmi időt ez nem nullázza: visszatérő, igazolt jogosultsághiány esetén a korábbi határidő érvényes.
- A három nap az első igazolt jogosultsághiánytól indul; nem a régi előfizetés lejáratára visszadátumozva. Aktív/trialing előfizetés, illetve még felhasználható saját próbaidő/korábbi hozzáférés esetén a fizetési tiltás megszűnik.
- A meglévő ütemezett végpont a Stripe-egyeztetés után legfeljebb 100 vállalkozást értékel, a legrégebbi ellenőrzéstől kezdve, majd legfeljebb 20 levelet próbál küldeni. A célzott 15 perces ütemezés nem pontos végrehajtási SLA. Sok ügyfélnél a futásonkénti kapacitást és a szolgáltatói korlátokat külön mérni kell.

## Tulajdonosi értesítés

A tulajdonos az adminpanel tetején mentheti saját megerősített e-mail-címét. A böngészőből megadott tetszőleges címzettet a művelet nem fogadja el. Az értesítési beállítás a platform egészére vonatkozik, nem az ügyfél szervezeti értesítési címére.

Az adatbázis tranzakcióban rögzíti az állapotváltozásról szóló, változatlan tartalmú levelet. Az ismételt ellenőrzés ugyanarról az állapotról nem generál új üzenetet. Az első egészséges állapot nem küld levelet; egy korábban jelzett probléma rendeződése igen. A kézi/automatikus mód váltása egy fennálló problémáról új összefoglalót hozhat létre.

A küldő neve, a címzett, a szöveg és az eseményazonosító az újrapróbálások között változatlan. A Resend kulcs `billing-owner-notice/<id>`. A szolgáltató [24 órán keresztül őrzi az ismétlésvédelmi kulcsokat](https://resend.com/changelog/idempotency-keys); a rendszer 23 órás automatikus újrapróbálási határt használ az első kísérlettől. Ezen túl `needs_review` jelzés keletkezik, a felületen figyelmeztetéssel és a figyelt ütemezőben hibával. Ez nem ígéret a postaládás kézbesítésre vagy végtelen ideig érvényes pontosan-egyszeri küldésre.

Kikapcsoláskor a küldés szünetel, a már sorba állított üzenetek megmaradnak a rögzített címzettel. Visszakapcsoláskor régebbi állapotjelentés is érkezhet; a levél ezért tartalmaz ellenőrzési időpontot és kéri az aktuális adminpanel ellenőrzését.

### Bizonytalan régi küldés rendezése (technikai kezelő)

1. Az értesítés azonosítója, címzettje, első kísérleti ideje és tartalma alapján keresd meg az üzenetet a Resend-naplóban. Ne feltételezd, hogy az adatbázis hiányzó `sent_at` értéke bizonyítja a sikertelen küldést.
2. Ha a szolgáltató igazolja az átvételt, egy ellenőrzött, szolgáltatói jogosultságú művelettel kizárólag a megfelelő értesítést jelöld feldolgozottnak: `sent_at`, `provider_id`, `needs_review=false`, `last_error=null`. A fogadott bizonyítékot rögzítsd az üzemeltetési naplóban.
3. Ha nem igazolható az eredmény, ne nullázd automatikusan a régi kulcs idejét. Ellenőrizd a tulajdonossal, szükséges-e új összefoglaló; csak jóváhagyott új üzenettel és új azonosítóval küldj, mert ismétlés lehetséges.
4. Átmeneti hiba a 23 órás határon belül automatikusan újrapróbálható az 5 perces foglalás után. A küldési hiba nem állítja le az ügyfél fizetésének értékelését.

## Telepítési sorrend

1. Alkalmazd az `20260921150000_billing_card_monitor.sql` migrációt a pontosan 52 korábbi migrációt tartalmazó környezetre. A szűk telepítő megtagadja az eltérő projektet vagy migrációs történetet:

   `node scripts/apply-billing-monitor-migration.mjs <környezeti-fájl> <projektazonosító> --apply`

2. Telepítsd az alkalmazást; ellenőrizd az `/api/health` végponton a kiadott commitot és az 53-as migrációszámot. A régi alkalmazás is elfogadja a hozzáadott táblákat; telepítéskor a fizetési tiltások alapértéke hamis.
3. Ellenőrizd a meglévő `RESEND_API_KEY`, `RESEND_FROM_EMAIL` és `RECONCILE_SWEEP_SECRET` beállításokat, valamint a GitHub-ütemező tényleges futását. Titkos értéket ne másolj jelentésbe.
4. A tulajdonosi értesítés és az ügyfelenkénti automatikus mód külön kapcsoló. Automatikus módot csak a kiválasztott ügyfelekre aktiválj, az ismertetett türelmi idővel.
5. Visszaállítás előtt minden fizetési tiltást ellenőrzötten oldj fel vagy állíts kézi módra: a régi alkalmazás nem mutatja az új állapotot, az adatbázisbeli beküldési védelem viszont megmarad. Táblát/előzményt ne törölj visszaállítás címén.

## Ellenőrzési bizonyíték

A változás tesztjei valódi PostgreSQL-en ellenőrzik a próbaidőt, a tiltást, új kártyát, kézi módot, rendezett hozzáférést, a kézi zárolás megőrzését, a régi/piszkos állapotot, az értesítések ismétlésvédelmét, a jogosultságokat és a párhuzamos beküldést. A böngészős teszt a külön Supabase-tesztprojekten a tulajdonosi felületből kapcsol módot és ellenőrzi a publikus kártyaoldalt. A fizetési állapotot ezekben mesterségesen állítjuk: nem állítjuk, hogy valós bankkártyaterhelést vagy postaládás kézbesítést reprodukáltak.

A Stripe `active` státusza jogosultsági jelzés, nem minden elképzelhető számlázási konfigurációban pénzbeérkezési bizonyíték; ezt a meglévő aktiválási logika továbbra is külön kezeli. [Stripe előfizetési állapotok](https://docs.stripe.com/billing/subscriptions/overview#subscription-statuses).
