# VéleményTap – tulajdonosi kézikönyv

Ügyfélbeállítás, NFC-kártyák programozása, értékesítés, átadás és napi működtetés. Frissítve: 2026. szeptember 21. A leírás a jelenlegi alkalmazás működését követi; a magyar gombnevek megegyeznek a felületen láthatókkal. A kézikönyv nem jelenti azt, hogy minden éles indulási ellenőrzés már megtörtént.

## 1. Mit értékesítesz?

A fizikai NFC-kártya az adott vállalkozáshoz és helyszínhez tartozó visszajelzési oldalt nyitja meg. A szoftver-előfizetés az ügyfél saját irányítópultjához biztosít hozzáférést: visszajelzések, belső megjegyzések, állapotok, statisztikák, helyszínek és kártyakezelés.

- Webáruház: https://velemenytap.hu
- Szoftver: https://velemenytap.com
- Havi előfizetés: **4 990 Ft**.
- Éves előfizetés: **49 900 Ft**, évente egy összegben. Ez **9 980 Ft megtakarítás** a tizenkét havi díjhoz képest.
- Az új vállalkozások **14 napos, bankkártya nélküli próbaidőt** kapnak, amely a vállalkozás létrehozásakor indul. Régebbi vállalkozásoknak korábban biztosított hozzáférésük is lehet, ezért ezekkel nem ellenőrizhető az új ügyfelek próbaideje.
- A fizikai kártya külön termék. Egy Shopify-rendelés jelenleg nem hoz létre automatikusan szoftverfiókot, nem rendeli hozzá a kártyát az ügyfélhez, és nem indít Stripe-előfizetést. A beállítást az alábbi lépések szerint kell elvégezni.
- Az irányítópulton a VéleményTapra beküldött visszajelzések jelennek meg. A rendszer nem importál Google-véleményeket, és nem tesz közzé értékelést a vendég nevében.

**A kártyák nemfizetés miatti kezelése vállalkozásonként választható:** kézi módban te döntesz a zárolásról; automatikus módban a rendszer a türelmi idő után letiltja a vállalkozás összes kártyalinkjét. Alapértelmezés: kézi mód, 3 nap türelmi idő. Az egyedi linket a 19., a fizetésfigyelő beállítását a 20. fejezet mutatja be.

## 2. Ellenőrzések az első fizető ügyfél előtt

A szoftver elérhető, de a beállítás megléte és a ténylegesen végigpróbált ügyfélfolyamat nem ugyanaz.

| Ellenőrzés | Eddigi bizonyíték / hátralévő teendő |
| --- | --- |
| Domain és árak | A .com címen az alkalmazás működik. Az éves ár és a fizetés előtti árellenőrzés a Stripe-ban korábban ellenőrzött 49 900 Ft-hoz igazodik. |
| Éles Stripe-beállítás | A két árazási azonosító és a két titkos beállítás neve látható volt a Vercel éles környezetében; az ezt követő közzététel elkészült. A titkos értékeket ez önmagában nem ellenőrzi. |
| Stripe-események fogadása | A `https://velemenytap.com/api/webhooks/stripe` végpont aktívként volt látható, `2026-08-26.dahlia` API-verzióval, a három előfizetési eseménnyel és az `invoice.paid` eseménnyel. Az akkori ellenőrzéskor még nem volt eseménykézbesítés. |
| Előfizetés-kezelő felület | Az éles Stripe-ügyfélportál beállítása létezik; a megfigyelt lemondási mód a fizetett időszak végén szünteti meg az előfizetést. Vásárlás után ellenőrizni kell a portál megnyitását. |
| Valódi vásárlás | Még szükséges: fizetés, sikeres Stripe-eseménykézbesítés, helyes előfizetési állapot, irányítópult-hozzáférés és a portál ellenőrzése. A tényleges fizetést a vásárló hagyja jóvá. |
| Fióklevelek a .com címen | Valódi regisztrációs és jelszó-visszaállító e-mailt kell fogadni, majd megnyitni a linkjeiket. Másik domain korábbi ellenőrzése ezt nem bizonyítja. |
| Visszajelzési értesítés | Az éles ügyfélfolyamatban, a címzett hozzájárulásával ellenőrizni kell a kézbesítést. Egy korábbi tesztlevél nem bizonyítja minden ügyfél értesítését. |
| Ütemezett számlázási egyeztetés | A szeptember 20-án ellenőrzött utolsó három futás sikeres volt. A legutóbbi 12:06 UTC-kor, budapesti idő szerint 14:06-kor indult, már az éles beállítások után. [A futás adatai](https://github.com/lbenyok/velemenytap/actions/runs/35509694064). Ez nem garantál pontosan 15 perces ütemezést vagy teljes fizetési folyamatot. |
| Jelszóvédelem | Szeptember 21-én az éles szolgáltatónál be volt kapcsolva a jelenlegi jelszó megkövetelése jelszócserekor. Az elkülönített tesztkörnyezet közvetlen API-próbája is sikeres volt; külön új éles támadási szimuláció nem történt. |
| Fizikai NFC-próba | Valódi kártya rendelkezésre állásáig nyitott. A működő böngészőlink nem bizonyítja a chip és a telefon együttműködését. |
| Üzleti háttér | Véglegesíteni kell az ügyfélszolgálati címet, a vállalkozási adatokat, a szerződési és adatkezelési tájékoztatást, a visszatérítési eljárást és a számlázást. A projekt `BUSINESS_DECISIONS.md` fájlja ezeket nyitott döntésként kezeli. |

Az ütemezett számlázási egyeztetéshez a Vercel éles környezetében és a GitHub Actions beállításaiban ugyanannak a `RECONCILE_SWEEP_SECRET` titkos értéknek kell szerepelnie. A GitHub `PRODUCTION_RECONCILE_SWEEP_URL` változója erre mutasson: `https://velemenytap.com/api/admin/reconcile-billing-sweep`. Titkokat kizárólag a szolgáltatások titkos beállításaiban tárolj, ne rendelési táblázatban, kártyán vagy ügyfélútmutatóban. A beállítások neve helyett a sikeres futást és annak eredményét kell ellenőrizni.

## 3. Milyen adatokat kérj be rendeléskor?

Vezess nyilvántartást a Shopify-rendelésszámról, a vállalkozás nevéről, a kapcsolattartóról, a fiók e-mail-címéről, a helyszínekről, helyszínenként a Google-értékelési linkről, a kártyák darabszámáról és a rendeléshez már megadott szállítási adatokról. A kártya árát a szoftver-előfizetéstől külön rögzítsd.

Kérdezd meg, melyik címre érkezzenek az alacsony értékelések értesítései. Az ügyfél e-mailes vagy Google-jelszavára, Stripe-belépésére és banki belépési adataira nincs szükséged.

A tulajdonosi kártyakezelő a **https://velemenytap.com/admin** címen található. Csak külön engedélyezett tulajdonosi fiókok érhetik el. Itt az ügyfél jelszava nélkül keresheted meg és zárolhatod vagy feloldhatod a kártyáit. Egy szokásos ügyfélfiók nem kezelheti más vállalkozások kártyáit.

Jelenleg nincs ügyfélfiókok közötti váltás, munkatársi meghívás vagy ügyfélként történő belépés. Minden ügyfél hozza létre és birtokolja a saját fiókját. Segíthetsz bejelentkezett állapotban, például képernyőmegosztással. Külön ügyfeleket ne hozz létre a saját vállalkozásodon belüli helyszínekként, mert összekeverednének az adataik.

## 4. Az ügyfél fiókjának létrehozása

1. Az ügyfél a https://velemenytap.com/signup oldalon regisztráljon saját e-mail-címével és jelszavával.
2. Nyissa meg a megerősítő e-mailt, és kattintson a benne lévő linkre. Ezután bejelentkezve a vállalkozás beállításához kell érkeznie.
3. Töltse ki a **Vállalkozás neve** mezőt, majd kattintson a **Tovább** gombra. Ezzel létrejön a vállalkozás, és elindul a próbaidő.
4. Kövesse a bemutató lépéseit. Később a https://velemenytap.com/dashboard címen térhet vissza.
5. Helyszínek és kártyák létrehozása előtt ellenőrizzétek a vállalkozás nevét.

Ha nem érkezik meg a levél, ellenőrizzétek a levélszemét mappát és a megadott címet, majd használjátok az újraküldést. Sok egymás utáni kérés küldési korlátba ütközhet. Ha a megerősítés vagy a jelszó-visszaállítás nem működik, először az e-mail-beállítást javítsátok; ne add át helyette a saját tulajdonosi fiókodat.

## 5. Helyszínek és Google-értékelési linkek

1. Az ügyfél fiókjában nyisd meg a **Helyszínek** oldalt: https://velemenytap.com/dashboard/locations.
2. Add meg a **Helyszín neve**, az opcionális **Cím** és a **Google-értékelés link** mezőket.
3. A linket az ügyfél a Google Cégprofiljából másolja ki, a vélemények megtekintésénél található további vélemények kérésére szolgáló lehetőséggel. Az angol felületen: **Read reviews → Get more reviews**. [A Google útmutatója](https://support.google.com/business/answer/16816815?hl=hu).
4. A pontos HTTPS-linket illeszd be, majd válaszd a **Helyszín hozzáadása** gombot.
5. Nyisd meg a mentett Google-linket, és ellenőrizd a vállalkozást és telephelyet. Tesztként ne tegyél közzé kitalált Google-véleményt.

A Google-link később is megadható, de nélküle a Google-oldal nem nyitható meg a folyamatból. Az alkalmazás támogatott Google-értékelési címeket fogad el, nem tetszőleges weboldalt. Ha elutasít egy linket, a Google Cégprofilból kérj értékelési linket; ne találj ki címet és ne használj külön rövidítőt.

## 6. Adatbázishoz kötött, egyedi kártyalink létrehozása

**Az egyedi linket a szoftver állítja elő. Nem kell kézzel adatbázisrekordot létrehoznod vagy azonosítót kitalálnod.**

1. Az ügyfél saját fiókjában nyisd meg az **NFC kártyák** oldalt: https://velemenytap.com/dashboard/nfc-cards.
2. Válaszd az **NFC kártya hozzáadása** lehetőséget.
3. Válaszd ki a megfelelő **Helyszín** értéket. Ez a hozzárendelés utólag jelenleg nem módosítható.
4. Adj felismerhető **Kártya neve** értéket, például `Recepció 01`, `Pult 02` vagy `4. asztal`.
5. Kattints a **Kártya hozzáadása** gombra. A rendszer a kártyát a vállalkozáshoz és helyszínhez rendelve elmenti az adatbázisba, és egyedi nyilvános azonosítót hoz létre.
6. Ellenőrizd az **Aktív** állapotot, majd másold ki a sor nyilvános linkjét. Formája: `https://velemenytap.com/r/<egyedi-azonosító>`. A szögletes zárójelek közötti rész csak helyőrző: a chipre a felületről kimásolt teljes, valódi link kerüljön.
7. A **Kipróbálás** lehetőséggel ellenőrizd, hogy a kívánt helyszín nyílik meg.

Minden külön letiltható fizikai kártyához külön kártyarekordot hozz létre. Ha több kártyára ugyanazt a linket írod, közös azonosítót használnak: a letiltás az összes példányt érinti.

A kártyatáblázat CSV-exportot is biztosít az előkészítéshez. Ez a linkek nyilvántartása, nem automatikus NFC-író. Címkézd a kártyákat vagy csomagolásukat, és tartsd nyilván, melyik kártyanév, link és ügyfél tartozik össze.

## 7. A link ráírása az NFC-kártyára

Írható NFC-kártya vagy címke, kompatibilis NFC-képes telefon és íróalkalmazás szükséges. A wakdev NFC Tools alkalmazása URL-rekordot is tud írni. A gyártó [URL-írási útmutatója](https://www.wakdev.com/en/knowledge-base/how-to-guides/how-to-write-a-link-url-on-an-nfc-chip.html) alapján:

1. Az NFC Tools alkalmazásban nyisd meg az írás részt, adj hozzá rekordot, és válaszd az URL/URI típust. Az angol gombok: **Write → Add a record → URL / URI**.
2. Illeszd be a kártyasorból kimásolt teljes VéleményTap-linket. A `https://` előtag pontosan egyszer szerepeljen.
3. Hagyd jóvá a rekordot. A kártyára a nyilvános VéleményTap-link kerüljön, ne az irányítópult vagy a közvetlen Google-oldal címe.
4. Válaszd az írás gombot, angolul **Write**. Tartsd az adott kártyát a telefon NFC-olvasójához, és várd meg a sikeres írást.
5. Olvasd vissza, és hasonlítsd össze a tárolt URL-t a nyilvántartással.
6. Az íróalkalmazáson kívül is próbáld ki a szokásos telefonos érintést. Telefontípustól függően a felugró értesítésre is rá kell koppintani. Az oldalhoz internetkapcsolat szükséges.

A szoftveres letiltás és a chip írásvédelme külön dolog. A VéleményTapban a letiltás visszavonható. A kezdeti beállításkor ne válaszd a chip végleges, csak olvasható lezárását: maradjon újraírható a link és működés ellenőrzéséig. Az útmutató nem ír elő végleges fizikai írásvédelmet.

Ha a kártya nem olvasható, először nyisd meg kézzel a linket. Ha az működik, ellenőrizd a telefon NFC-támogatását, beállítását, az érintési helyet, valamint a kártya sérülését vagy írásvédelmét. Sérült chipet szoftverbeállítással nem lehet megjavítani.

## 8. Értesítési e-mailek beállítása és ellenőrzése

1. Nyisd meg a **Beállítások** oldalt: https://velemenytap.com/dashboard/settings.
2. Add meg az ügyfél által választott **Értesítési e-mail cím** értéket, majd válaszd a **Változtatások mentése** gombot.
3. A címzett nyissa meg az új címre érkező megerősítő linket. Addig az új cím nem aktív értesítési cím.
4. Külön cím hiányában a jogosult, megerősített e-mail-című szervezeti tagok kapják az értesítést. Egy új, egyetlen tulajdonossal létrehozott vállalkozásnál ez a tulajdonost jelenti. Ettől még nincs munkatársi meghívási funkció.
5. Az ügyfél hozzájárulásával küldj egy egyértelműen tesztként megjelölt, alacsony értékelést egy beállításhoz használt kártyán, és ellenőrizd a levél megérkezését.

Az értesítési küszöb **1–3 csillag**. Kártyánként ötperces várakozási idő és vállalkozásonként óránként **30 értesítési küldéses korlát** van. A visszajelzés mentése és az e-mail külön folyamat: a levél kézbesítése meghiúsulhat, és a korlát miatt kihagyott értesítésekhez nincs garantált későbbi összesítő. Akkor is nézd meg az irányítópultot, ha nem jött levél. A küszöböt és korlátokat az ügyfél jelenleg nem módosíthatja a felületen.

## 9. A vendég folyamatának megértése és tesztelése

A vendég kiválasztja a csillagokat, majd megnyomja a **Vélemény küldése** gombot. A csillagok kiválasztása önmagában nem mentés.

- **1–3 csillag:** megjegyzést is írhat. A küldés elmenti a belső visszajelzést. Érvényes Google-link esetén a visszaigazoló oldalon megjelenik a kis Google-gomb.
- **4–5 csillag:** a küldés új lapon megnyitja a Google-értékelési oldalt, és az eredeti oldalon elindítja a pontszám mentését. A mentés eredménye az eredeti oldalon ellenőrizhető. A Google-véleményt a vendégnek még külön el kell készítenie és közzé kell tennie.
- **Nincs Google-link:** a belső visszajelzés minden csillagértéknél beküldhető, de Google-oldal nem nyitható meg.
- **Inaktív kártya vagy helyszín:** az oldal nem fogad új visszajelzést. A letiltás előtt megnyitott űrlap későbbi beküldését is elutasítja.

Ügyfelenként ellenőrizd, hogy az értékelés a megfelelő helyszín és kártya alatt jelenik meg: https://velemenytap.com/dashboard/feedback. Mindkét értékelési ágat teszteld, megjelölt próbaadatokkal és a címzett hozzájárulásával. Az ismételt beküldési és forgalmi korlátok megakadályozhatnak újabb gyors teszteket ugyanabból a böngészőből; ezért ne kapcsold ki a védelmeket. A nyitóoldal csillagválasztója csak bemutató, nem ment adatot.

## 10. Kártya távoli zárolása és feloldása

**Neked, a VéleményTap tulajdonosaként:** nyisd meg a https://velemenytap.com/admin oldalt. Keresd meg az ügyfelet, nyisd meg a kártyáját, adj meg indoklást, majd válaszd a **Kártya zárolása** gombot. Az ilyen zárolást csak platform-adminisztrátor oldhatja fel, a **Zárolás feloldása** gombbal. A zárolás előtti aktív vagy inaktív állapot áll vissza. Mindkét művelet bekerül a naplóba. A tulajdonosi panel nem függ a saját vállalkozásod előfizetésétől.

**Az ügyfél saját kártyáihoz:** a szokásos aktiválás és deaktiválás elérhető, amíg te nem zároltad a kártyát. Az ügyfél a tulajdonosi zárolást nem oldhatja fel.

Az ügyfél kártyakezelése aktív próbaidőhöz, előfizetéshez vagy meglévő korábbi jogosultsághoz kötött irányítópult-hozzáférést igényel. Telefonon nyissa meg a menüt. Az **NFC kártyák** oldalon keresse meg a kártyát, válassza a **Deaktiválás** gombot, várja meg az **Inaktív** állapotot, majd frissítse a nyilvános linket. Annak jeleznie kell, hogy a kártya nem aktív. A korábbi visszajelzések megmaradnak.

Visszaállításhoz válassza az **Aktiválás** gombot, várja meg az **Aktív** állapotot, majd nyissa meg ugyanazt a linket. A fizikai kártyát nem kell újraírni. Hibaüzenet esetén a változás nem tekinthető sikeresnek; előbb oldjátok meg a hibát.

A zárolás az adott linket és minden másolatát érinti. Nem kapcsolja ki a chipet, nem törli a korábbi Google-véleményeket, és nem akadályozza meg a Google közvetlen felkeresését. A helyszín deaktiválása is leállítja az oda tartozó kártyákat. Ha aktív kártya oldala mégis inaktív, a helyszínt is ellenőrizd.

Másik helyszínre költöztetéshez jelenleg új kártyarekord és az új URL fizikai kártyára írása szükséges. A régi rekordot deaktiváld, az előzményeket őrizd meg. Az egyszerű zárolás és feloldás viszont megtartja az eredeti linket.

## 11. A szoftver-előfizetés elindítása

Az ügyfél nyissa meg a **Számlázás** oldalt: https://velemenytap.com/dashboard/billing. Válasszon havi vagy éves fizetést, majd lépjen tovább a Stripe felületére. Saját fizetési adatait ő adja meg, és ő hagyja jóvá a fizetést. A Shopifyban megvett fizikai kártya nem szoftver-előfizetési befizetés.

Az első valódi vásárlás előtt ellenőrizzétek, hogy a Stripe a választott **4 990 Ft/hó** vagy **49 900 Ft/év** összeget mutatja. Fizetés után térjetek vissza az alkalmazásba, és ellenőrizzétek az előfizetés állapotát és az irányítópult elérését. A Stripe-ban a tényleges fizetést és az eseménykézbesítést is ellenőrizni kell. A sikeresnek tűnő visszatérési URL önmagában nem bizonyítja a fizetést.

A számlázási oldalról nyissátok meg az előfizetés-kezelő portált, és ellenőrizzétek a számlázási adatokat és a megújítás lemondásának lehetőségét. A korábban megfigyelt portálbeállítás szerint a lemondás a fizetett időszak végén lép életbe. A közzétett visszatérítési és számlázási feltételeidet kövesd; egy Stripe-bizonylatból önmagában ne következtess arra, hogy minden magyar számlázási követelmény teljesül.

## 12. Ügyfélátadási ellenőrzőlista

- [ ] Az ügyfél birtokolja saját fiókját, és önállóan be tud lépni.
- [ ] A helyes vállalkozást, helyszínt és Google-oldalt ellenőriztétek.
- [ ] Minden kártyának van neve, ügyfélhez rendelése és saját, ráírt .com nyilvános linkje.
- [ ] A rendelkezésre álló telefonokon megtörtént a normál NFC-érintési próba.
- [ ] Mindkét értékelési útvonalat ellenőriztétek; a mentett adatok a megfelelő irányítópulton látszanak.
- [ ] Az értesítési címet megerősítették, és az engedélyezett tesztértesítés megérkezett.
- [ ] Bemutattad a deaktiválást és aktiválást a chip újraírása nélkül.
- [ ] Az ügyfél ismeri a **Vélemények**, **Elemzés**, **NFC kártyák**, **Beállítások** és **Számlázás** menüket.
- [ ] Elmagyaráztad az előfizetési díjat, a külön kártyaárat, a lemondást és a támogatási elérhetőséget.
- [ ] Csak az ellenőrzések után jelölted késznek a beállítást; a nyitott teendőket feljegyezted.

Add át az irányítópult linkjét, a kártyák nyilvántartását és a tényleges támogatási elérhetőségedet. Jelszó és titkos API-kulcs ne kerüljön az átadási anyagba.

## 13. Napi használat és hibaelhárítás

Az ügyfél a **Vélemények** oldalon szűrhet, **Belső megjegyzés** értéket adhat hozzá, és az **Új → Folyamatban → Megoldva** állapotokat használhatja. A belső megjegyzés és állapotváltás nem küld választ a vendégnek, és nem ír a Google-re. Az **Elemzés** a belső visszajelzések alakulását és megoszlását mutatja.

| Jelenség | Mit ellenőrizz először? |
| --- | --- |
| Másik vállalkozást nyit meg a kártya | Olvasd ki a chip URL-jét, és hasonlítsd össze a megfelelő kártyarekorddal és Google-linkkel. |
| Inaktív a kártya oldala | Ellenőrizd a tulajdonosi zárolást, a kártyát és a helyszín állapotát. |
| Nem nyílik meg a Google | Ellenőrizd a mentett Google-linket, majd az adott telefon és böngésző működését. |
| Hiányzik egy értékelés | Nézd meg az eredeti oldal mentési eredményét, a megfelelő vállalkozást, kártyát, szűrőket és az ismételt beküldésről szóló üzenetet. A Google-lap megnyílása nem bizonyít mentést. |
| Nem jön értesítés | Ellenőrizd az 1–3 csillagos értéket, a cím megerősítését, a levélszemetet és a küldési korlátokat, majd a kézbesítési naplókat. |
| Fizetett, de nincs hozzáférése | Jegyezd fel a Stripe-fizetés és előfizetés azonosítóját; ellenőrizd az eseménykézbesítést és állapotegyeztetést. Ne kérj újabb fizetést javításként. |
| Elfelejtett jelszó | A belépési oldalon használja a jelszó-visszaállítást. Ne küldj közös jelszót. |

Tulajdonosként figyeld a sikertelen Vercel-kéréseket, Stripe-eseménykézbesítéseket, az ütemezett számlázási egyeztetést és az e-mail-hibákat. Vezess naprakész rendelési nyilvántartást, és legyen tesztelt mentési-visszaállítási eljárásod. A sikeres közzététel nem helyettesíti ezeket az üzemeltetési ellenőrzéseket.

## 14. A webáruház, az előfizetés és a kártya összekapcsolása

Nincs automatikus Shopify–VéleményTap fiók- és kártyalétrehozás. A csomagot a 2. fejezet ellenőrzései után **kézi, támogatott ügyfélbeállítással** lehet értékesíteni. A Shopify-vásárlás nem aktiválja automatikusan a szoftver-előfizetést.

| Rész | Hol történik? | Mi kapcsolja össze? |
| --- | --- | --- |
| Kártyavásárlás és szállítás | velemenytap.hu / Shopify | Rendelési és teljesítési nyilvántartás |
| Ügyfélfiók és vállalkozás | velemenytap.com | Az ügyfél megerősített fiókja és saját vállalkozása |
| Előfizetés | Számlázás → Stripe | Az alkalmazás a vállalkozás azonosítójával indítja a fizetést |
| Fizikai kártya | NFC Tools | A chipre írt pontos `/r/<egyedi-azonosító>` URL |
| Visszajelzések és Google-céloldal | A helyszín- és kártyarekord | A kártya vállalkozáshoz és helyszínhez rendelése |
| Tulajdonosi zárolás | velemenytap.com/admin | A kártyarekord állapota; a link minden másolata ezt követi |

**Javasolt sorrend:** kártyarendelés → ügyfélregisztráció → helyszín → kártyarekord → link kimásolása → chip megírása → visszajelzés és e-mail tesztelése → előfizetés választása → átadás és szállítás. Az ügyfél próbaidő alatt is választhat előfizetést. A vállalkozás létrehozásával elindul a próbaidő, ezért ne hozd létre hetekkel a teljesítés előtt.

A szokásos értékesítéshez ne készíts külön, alkalmazástól független Stripe-fizetési linket, és ne hozz létre kézzel előfizetést abban a hitben, hogy automatikusan hozzárendelődik. Az alkalmazás fizetési folyamata rögzíti a vállalkozás, a Stripe-ügyfél és az előfizetés kapcsolatát, és kezeli a párhuzamos kísérleteket. A máshol beszedett összeg nem kapcsolódik hozzá automatikusan attól, hogy egyezik az e-mail-cím.

### A Shopify-ajánlat beállítása

1. A meglévő áruházban a kártyát fizikai termékként kezeld, tényleges készlet- és szállítási adatokkal.
2. A jóváhagyott kártyaárat és szállítási díjat Shopifyban add meg. A kártyaár ebben az útmutatóban még tulajdonosi döntés; nincs kitalált összeg.
3. A termékoldalon jelezd: a kártya egyszeri vásárlás, az irányítópult külön, ismétlődő díjú szolgáltatás, **4 990 Ft/hó** vagy **49 900 Ft/év**, jelenleg 14 napos bankkártya nélküli próbával.
4. Írd le, hogy a kártya a VéleményTap visszajelzési oldalát nyitja meg, a Google-véleményt pedig a vendég külön teszi közzé. Ne hirdess automatikus közzétételt vagy Google-véleményimportot.
5. Tegyél regisztrációs linket a `https://velemenytap.com/signup`, belépési linket a `https://velemenytap.com/login` címre. Az előfizetés az ügyfél saját **Számlázás** menüjéből indul.
6. Az általad programozott és feladott kártyáknál használj kézi rendelésteljesítést. Ellenőrizd a fizetést, írd meg és teszteld a kártyát, majd a valóban feladott tételeket jelöld teljesítettként. Valós nyomkövetési adatot adj meg. A fizetés önmagában nem jelenti azt, hogy a kártya elkészült vagy úton van.
7. Párosítsd a rendelést a vállalkozással és kártyalinkekkel a saját nyilvántartásodban. Jelszót ne tárolj benne.

A Shopify [hivatalos kézi teljesítési útmutatója](https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/single-fulfillment) ismerteti az egyedi teljesítést. A fenti pontok útmutatást adnak: ettől még nem módosult az áruház témája, készlete, szállítása vagy termékei.

### Példa: egy kávézó két kártyát vesz

- A kávézó két kártyát rendel a .hu áruházból.
- Tulajdonosa regisztrál a .com oldalon, és létrehozza saját vállalkozását.
- Együtt létrehozzátok a helyszínt, és ellenőrzitek a Google-linket.
- Létrehoztok két kártyarekordot: `Pult 01` és `Terasz 01`. Kimásoljátok a két külön linket.
- Mindegyik chipre a megfelelő linket írod, és feliratozod a csomagolást.
- Ellenőrzitek a kártyánként megjelenő értékeléseket és az engedélyezett tesztértesítés kézbesítését.
- Az ügyfél saját számlázási oldalán fizet elő. Az előfizetés a vállalkozáshoz tartozik, nem külön-külön a fizikai kártyákhoz.
- Rögzíted: rendelés → vállalkozás → helyszín → kártyanév → URL → érintési próba → átadás. A fizetés és a beállítás állapotát külön kezeld.
## 15. Hogyan mutasd be és értékesítsd?

A termék értéke a könnyen elérhető visszajelzési oldal, a vállalkozás saját irányítópultja és a visszajelzések követése. Ne ígérj garantált értékelésszámot, bevételnövekedést vagy jobb Google-helyezést.

### Másolható rövid bemutató

> A VéleményTap kártyát a vendég a telefonjához érinti, és megnyílik a vállalkozás visszajelzési oldala. A beküldött értékeléseket egy saját irányítópulton látod, helyszín és kártya szerint. Az alacsony értékelésekről e-mailes értesítést állíthatsz be, és követheted, melyik visszajelzéssel foglalkoztál már. A Google-értékelési oldaladat is elérik a vendégek; a Google-on a véleményt ők teszik közzé. A kártya külön vásárolható meg, a szoftver 4 990 Ft havonta vagy 49 900 Ft évente, és 14 napig bankkártya nélkül kipróbálható.

Ne állítsd, hogy minden értesítés azonnal megérkezik, hogy a rendszer eltávolítja a negatív Google-véleményeket, importálja a Google-értékeléseket, vagy választ küld a vendégnek a belső megjegyzésből. Ne ígérj korlátlan idejű ingyenes szoftvert vagy automatikus Shopify-fiókbeállítást.

### Ötperces bemutató

1. Nyisd meg egy bemutatókártya linkjét telefonon. Ha nincs fizikai kártyád, mondd el, hogy most a linket mutatod, nem az NFC-érintést teszteled.
2. Küldj be egy egyértelműen tesztként megjelölt visszajelzést a bemutató vállalkozáshoz.
3. Mutasd meg az irányítópulton a csillagokat, a szöveget, a helyszínt és a kártyát.
4. Mutasd meg a belső megjegyzést és a feldolgozási állapotot. A Google-oldalt megnyithatod, de ne tegyél közzé kitalált ügyfélvéleményt.
5. Egy bemutatókártyán szemléltesd a tulajdonosi zárolást és feloldást. Működő ügyfélkártyát ne használj erre.
6. Mondd el az egyszeri kártyavásárlás és a szoftver-előfizetés különbségét, a két előfizetési árat és a próbaidőt.

A havi díj a szoftverszolgáltatásért jár, nem az NFC-chip működéséért. Kézi módban az előfizetés megszűnése önmagában nem tiltja le a nyilvános kártyalinket. Automatikus módban a türelmi idő után a fizetésfigyelő tiltja le. A két működést a 19–20. fejezet írja le.

Az első ügyfeleket személyesen segítsd végig. Jegyezd fel, mennyi idő a regisztráció, a helyszín és a kártyák létrehozása, hol akadnak el, működik-e az értesítés, és mennyi segítség kell az első előfizetéshez. Ezekből derül ki, hogy az átadási folyamat ténylegesen használható-e.

### Google-értékelések kommunikációja

A csillagszámtól függő vendégút nem jelent igazolt Google-jóváhagyást. A Google-értékelési lehetőség minden vendég számára azonos láthatóságú felkínálása csökkenti a szelektív értékeléskérés kockázatát. A Google saját [értékelési útmutatóját](https://support.google.com/business/answer/7400114) és [értékeléskérési útmutatóját](https://support.google.com/business/answer/3474122?hl=hu) használd a kommunikáció ellenőrzéséhez. A kézikönyv fordítása nem változtatja meg a jelenlegi vendégfolyamatot.

## 16. Az első valódi fizetős beállítás végigellenőrzése

A korábbi automatikus ellenőrzések nem helyettesítik a valódi fizetést, postaládát és fizikai kártyát. Az első ügyfélnél ezeket külön ellenőrizd:

1. Valóban elérhető e-mail-címmel regisztráljatok, és kattintsatok a ténylegesen megérkezett megerősítő levélre.
2. Ellenőrizzétek, hogy a megfelelő vállalkozás és próbaidő jelenik meg.
3. Hozzatok létre helyszínt és kártyát, majd ellenőrizzétek a Google-linket és a beküldött tesztvisszajelzést.
4. Az ügyfél saját Számlázás oldalán válassza ki az előfizetést. Fizetés előtt ellenőrizze az összeget, pénznemet és ismétlődést. Valódi vásárlást csak a fizető fél tudtával végezzetek.
5. Ellenőrizd a Stripe-ban a sikeres fizetést és az esemény kézbesítését, majd a szoftverben az előfizetés állapotát. A sikeres visszatérő oldal önmagában nem bizonyítja a fizetés feldolgozását. Késés esetén ne indítsatok azonnal újabb vásárlást.
6. Nyissátok meg az ügyfél számlázási portálját. Lemondást csak akkor hajtsatok végre, ha valóban ez a szándék; nézzétek meg a hozzáférés végének dátumát.
7. Ellenőrizd a számlázási bizonylatot és a tényleges számlázási folyamatot. Könyvelővel tisztázd, milyen számlát kell kiállítanod; a Stripe fizetési visszaigazolását ne tekintsd automatikusan minden követelményt teljesítő számlának.
8. Ellenőrizzétek egy engedélyezett tesztértesítés és egy jelszó-visszaállító levél valódi kézbesítését és a hivatkozás működését.
9. Fizikai NFC-kártyával próbáljátok ki az érintést, az oldal megnyitását, a kártyához tartozó beküldést, majd egy bemutatókártyán a zárolást és feloldást.

Rögzítsd a dátumot, a környezetet, az eredményt és a még nyitott hibát. A szimulált levélküldés vagy közvetlenül létrehozott megerősítési hivatkozás nem valódi postaládás ellenőrzés. A link telefonos megnyitása nem fizikai NFC-teszt.

## 17. Tulajdonosi napi rutin

**Új rendelések:** párosítsd a Shopify-rendelést a vállalkozással és a kártyákkal. Ellenőrizd külön a fizikai termék és a szoftver fizetését. A Google-link módosítása a helyszín beállításaiban történik; ha ugyanaz a VéleményTap-kártyalink marad, a chipet nem kell újraírni.

**Ügyfélszolgálat:** kérj vállalkozásnevet, kártyanevet vagy kártyalinket és pontos hibaleírást. Ne kérj jelszót. Az adminpanel nem biztosít ügyfélként történő belépést. Fiókon belüli beállításnál az ügyfél a saját fiókjában dolgozzon, szükség esetén közös képernyős segítséggel.

**Elveszett vagy visszavont kártya:** keresd meg és zárold az adminpanelben. Cserekártyához hozz létre új kártyarekordot és új linket, ha a régi példányt végleg használhatatlanná akarod tenni.

**Lemondás vagy fizetési probléma:** ellenőrizd a Stripe tényleges állapotát és a már kifizetett időszak végét. Az előfizetés lemondása nem feltétlenül azonnali lejárat. Nézd meg, hogy az adott vállalkozás kézi vagy automatikus módban van-e. A kézi eljárás a 19., az automatikus a 20. fejezetben található.

**Működés:** figyeld a sikertelen fizetési eseményeket, a kézbesítési hibákat és az ütemezett feldolgozások hibajelzéseit. Egy zöld weboldal nem bizonyítja, hogy minden háttérfolyamat működik.

**Domain és helyreállítás:** tartsd érvényben a velemenytap.com domaint, mert a kiadott kártyák ezt a címet használják. Költözésnél a már kiadott /r/ hivatkozások működését is őrizd meg. Ellenőrizd a mentési lehetőségeket és a visszaállítás menetét; ne állítsd, hogy a visszaállítás kipróbált, amíg nincs erről tényleges próba.

## 18. Másolható ügyfélátadási üzenet

A szögletes zárójelben lévő adatokat küldés előtt cseréld ki. Csak azt jelöld elkészültnek, amit ténylegesen ellenőriztél. Ez egy sablon; a rendszer nem küldi el automatikusan.

> Szia [név]!
>
> Elkészült a [vállalkozás neve] VéleményTap-beállítása.
>
> Belépés: https://velemenytap.com/login
>
> A fiókod e-mail-címe: [ügyfél e-mail-címe]
>
> Helyszín: [helyszín neve]
>
> Kártyák: [kártyanevek és a hozzájuk tartozó linkek]
>
> Az NFC-kártya a saját VéleményTap-visszajelzési oldaladat nyitja meg. A beküldött visszajelzéseket az irányítópulton találod. A Google-véleményt a vendég a Google oldalán külön teszi közzé.
>
> Értesítési cím: [ellenőrzött e-mail-cím]. Az alacsony értékelésekről az engedélyezett értesítési beállítások és küldési korlátok szerint kapsz levelet.
>
> A szoftver-előfizetést a Számlázás menüben indíthatod el: 4 990 Ft/hó vagy 49 900 Ft/év. A próbaidő vége: [a fiókban látható dátum]. A fizikai kártya külön termék.
>
> Kérlek, próbáld ki a kártyát a telefonoddal, és ellenőrizd az első tesztvisszajelzést az irányítópulton. Ha kérdésed van, itt érsz el: [tényleges ügyfélszolgálati elérhetőség].
>
> Üdvözlettel:
> [név] – VéleményTap

## 19. Egyedi kártyalink és zárolás nemfizetés esetén

### Hogyan lesz a link az adatbázisban?

**Nem kell kézzel linket kitalálnod vagy adatbázissort létrehoznod.** Amikor az ügyfél saját fiókjában, az NFC-kártyák oldalon létrehoztok egy kártyát, a rendszer elmenti a vállalkozáshoz és helyszínhez tartozó rekordot az adatbázis `nfc_cards` táblájába, és egyedi nyilvános azonosítót ad neki.

A másolható cím alakja: `https://velemenytap.com/r/<a-kártya-egyedi-azonosítója>`. A zárójelezett rész csak magyarázó helyőrző: az NFC-re mindig a felületen kimásolt, teljes valódi címet írd.

A folyamat:

1. Az ügyfél regisztrál és létrehozza saját vállalkozását.
2. Saját fiókjában létrehozza a helyszínt, és megadja a Google-értékelési címet.
3. Az **NFC-kártyák** oldalon létrehoz egy kártyát a megfelelő helyszínhez, például `Pult 01` néven. Ebben segíthetsz neki, de nem kell elkérned a jelszavát.
4. Kimásoljátok a kártya teljes VéleményTap-linkjét. Ekkorra a kártya már az adatbázisban van.
5. Ezt az URL-t írod a fizikai kártyára az NFC Tools alkalmazással, a 7. fejezet szerint.
6. A saját tulajdonosi fiókodból az adminpanelben megkeresheted és zárolhatod ezt a kártyát.

**Az adminpanel jelenleg meglévő kártyákat kezel; nem tudsz benne egy másik vállalkozás nevében új kártyát létrehozni.** Az ügyfél saját fiókjában kell létrehozni a rekordot. Jelenleg nincs szabadon megadható rövid kártyacím, például /r/kavezo-pult; a rendszer által generált egyedi azonosítót használd. A kijelzett kártyanév ettől függetlenül lehet beszédes.

Minden külön követni vagy tiltani kívánt fizikai kártyához külön rekordot készíts. Ha két chipre ugyanazt a linket írod, a rendszer ugyanannak a kártyának látja őket, és a zárolás mindkettőt érinti.

### Mit tegyél, ha nem sikerül a fizetés?

**Kézi módban a sikertelen Stripe-fizetés nem zárolja automatikusan a nyilvános kártyalinkeket.** Az automatikus mód és a 3 napos türelmi idő beállítását a 20. fejezet mutatja be. A következő eljárás kézi tulajdonosi zárolás:

1. Döntsd el, melyik fizetésről van szó: a Shopifyban vásárolt fizikai kártyáról vagy a Stripe-ban kezelt szoftver-előfizetésről. Ezek külön fizetések.
2. Ellenőrizd a Stripe-ban az érintett ügyfelet, az előfizetést és a jogosultság végét. Egyetlen sikertelen terhelési kísérlet nem bizonyítja, hogy már megszűnt a jogosultsága: lehet még próbaidő, kifizetett időszak, folyamatban lévő fizetés vagy időszak végére beállított lemondás.
3. Lépj be a saját tulajdonosi fiókoddal a [VéleményTap adminpaneljébe](https://velemenytap.com/admin).
4. Keresd meg a vállalkozást és a megfelelő kártyát. Jelenleg kártyánként kell eljárnod, nincs teljes vállalkozást egy kattintással zároló művelet.
5. Ha az ellenőrzött helyzet és az ügyféllel vállalt feltételek alapján indokolt a tiltás, adj meg pontos indokot, például: `Előfizetés lejárt; fizetés ellenőrizve: 2026. 09. 21.`, majd használd a kártya zárolási műveletét.
6. Ellenőrizd a tulajdonosi zárolás jelzését, majd nyisd meg a kártya nyilvános linkjét. A visszajelzési oldalnak az inaktív állapotot kell mutatnia. Ezt a zárolást az ügyfél saját kártyakapcsolója nem oldhatja fel.
7. A tartozás rendezése után előbb ellenőrizd a tényleges fizetést, majd az adminpanelben oldd fel a zárolást. A feloldás a zárolás előtti kártyaállapotot állítja vissza: egy korábban is inaktív kártya ettől nem lesz automatikusan aktív.

A chipet ehhez nem kell visszakérned vagy újraprogramoznod. Ugyanaz a link marad rajta; a weboldal az adatbázisból ellenőrzi a kártya állapotát. A zárolás nem törli a korábbi visszajelzéseket.

### Mi automatikus, és mi kézi?

| Művelet | Jelenlegi működés |
| --- | --- |
| Kártya mentése az adatbázisba és egyedi link létrehozása | Automatikus a kártya felületen történő létrehozásakor. |
| Kártya vállalkozáshoz és helyszínhez kapcsolása | A létrehozáskor megadott adatok alapján történik. |
| Link felírása a fizikai chipre | Kézi művelet NFC-író alkalmazással. |
| Tulajdonosi zárolás érvényesítése a nyilvános oldalon | A mentett kártyaállapot alapján történik. |
| Nemfizetés miatti zárolás eldöntése és elindítása | Kézi vagy vállalkozásonként bekapcsolható automatikus mód. |
| Fizetés utáni feloldás | Az automatikus fizetési tiltás rendezett hozzáférésnél feloldódik. A kézi kártyazárolást továbbra is te oldod fel. |
| Shopify-rendelés automatikus összekapcsolása a szoftverfiókkal | Jelenleg nincs ilyen automatikus összekapcsolás. |

Az automatikus fizetési tiltás külön működik a kézi kártyazárolástól. A fizetés rendezése nem oldhatja fel az elveszett kártyára vagy más okból beállított kézi tulajdonosi zárolást.

## 20. Fizetésfigyelő, tulajdonosi e-mail és automatikus mód

### Bekapcsolás

1. Lépj be a saját tulajdonosi fiókoddal a https://velemenytap.com/admin oldalra.
2. A **Tulajdonosi fizetési értesítések** résznél kapcsold be az e-mailes értesítést, és mentsd el. A címzett a saját megerősített belépési e-mail-címed lesz. Ez közös tulajdonosi beállítás; másik platform-adminisztrátor mentése a saját címére változtatja.
3. Nyisd meg a kívánt vállalkozást. A **Fizetésfigyelő és automatikus zárolás** résznél válassz kézi vagy automatikus módot.
4. Hagyd meg a jóváhagyott **3 napos türelmi időt**, majd kattints a **Fizetési mód mentése** gombra. A türelmi idő vállalkozásonként módosítható.
5. A **Fizetés ellenőrzése most** gomb frissíti a Stripe-adatokat és kiértékeli a kártyák fizetési állapotát. Az e-mailt az ütemezett feldolgozó küldi el.

A fejlesztés adatbázis-módosításának és alkalmazásának együttes telepítése szükséges. Ha még nem látod ezt a részt az adminpanelen, az új változat még nincs azon a környezeten. Telepítéskor minden vállalkozás kézi módban indul, és az e-mail-küldés külön bekapcsolást igényel.

### Mi történik nemfizetéskor?

- A rendszer a Stripe-ból egyeztetett jogosultságot és a saját próbaidőt figyeli. A még érvényes próbaidőt, korábbi külön hozzáférést és aktív előfizetést figyelembe veszi. Az időszak végére beállított lemondás önmagában nem azonnali tiltás.
- A 3 nap az első igazolt jogosultsághiány észlelésétől indul. Bevezetéskor a régen lejárt fiókokat sem tiltja visszamenőleg azonnal.
- **Kézi mód:** értesítést kapsz, de a kártyák fizetési okból tovább működnek. Az egyedi kártyazároló gombbal te intézkedhetsz.
- **Automatikus mód:** a türelmi idő lejárta után az adott vállalkozás valamennyi kártyalinkje inaktívvá válik, beleértve a később létrehozott kártyákat is. A korábban megnyitott űrlap beküldését az adatbázis is elutasítja.
- **Rendezett hozzáférés:** a következő sikeres kiértékelés feloldja a fizetési tiltást. Az ügyfél által inaktivált kártyák, inaktív helyszínek és kézi tulajdonosi zárolások megmaradnak.
- **Átváltás kézi módra:** megszünteti a fizetési tiltást. Ha a kártyát tiltva akarod tartani, használj külön kézi zárolást.
- **Bekapcsolás már lejárt türelmi idővel:** az automatikus mód mentése azonnali tiltást eredményezhet. Mentés előtt nézd meg az állapotot és a határidőt.

Az ellenőrzés a meglévő, célzottan 15 percenként induló ütemezés része. Az ütemező és a szolgáltatók késése miatt ez nem azonnali vagy garantáltan pontos időzítés. Egy futás legfeljebb 100 vállalkozást értékel; nagyobb állománynál a következő futások folytatják a legrégebben ellenőrzöttekkel. A Stripe-adatok rendszeres frissítése külön is működik. Hiányos, hibás vagy 2 óránál régebbi Stripe-adatból nem keletkezik új tiltás, és a meglévő fizetési tiltás sem oldódik fel igazolás nélkül. Ilyenkor az adminpanel ellenőrzést kér.

### Milyen levelet kapsz?

Értesítés készül az első fizetési problémáról vagy lejárt jogosultságról, a türelmi idő végéről / automatikus tiltásról és a hozzáférés rendeződéséről. Ugyanarra az állapotra nem készül minden futásnál új levél. A levél tartalmazza a vállalkozást, a kezelési módot és az adminpanel hivatkozását. Ez tulajdonosi értesítés, nem fizetési felszólítás az ügyfélnek, és nem a vendégek alacsony csillagszámú értékeléseiről szóló értesítés.

A **Legutóbbi fizetési értesítések** listában látod a küldés állapotát. Az „E-mail-szolgáltató átvette” nem bizonyítja a beérkezést a postaládába. Sikertelen vagy bizonytalan küldésnél a rendszer ugyanazt az üzenetet próbálja újra. 23 órán túl bizonytalan eredmény esetén kézi ellenőrzést jelez, hogy ne küldjön korlátlanul ismétlődő leveleket. A szolgáltatói napló ellenőrzésében ilyenkor technikai segítség szükséges. Az értesítés kikapcsolása a várakozó levelek küldését is szünetelteti; visszakapcsolás után korábbi állapotjelentés is megérkezhet, ezért intézkedés előtt mindig az aktuális adminpanelt nézd.

A kártyák leállításához nincs szükség a fizikai chip visszakérésére. A rendszer a saját adatbázisban őrzi a link és a vállalkozás kapcsolatát; a korábbi visszajelzések megmaradnak.

---

Kézikönyv frissítve: **2026. szeptember 21.** Teljes magyar tulajdonosi útmutató, a választható fizetésfigyelő működésével. A tényleges éles telepítés és a valódi postaládás ellenőrzés külön ellenőrzendő; a szoftvertesztek önmagukban nem bizonyítják ezeket.
