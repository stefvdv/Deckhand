# Deckhand — werkafspraken voor Claude

Deckhand is Stefs MTG-deckbuilder. Het is een PWA die vooral bestaat uit `index.html` (alle app-code in één bestand) en `sw.js` (de service worker), met daarnaast `version.json` en Netlify-functies.

- **Live zetten:** elke push naar `main` gaat via Netlify meteen live (deckhandcompanion.netlify.app).
- **Testen:** Stef test alleen op Android (Fairphone) en soms op een pc. Zijn screenshots en video's zijn de waarheid.
- **Taal:** schrijf aan Stef in kort, gewoon Nederlands, zonder vakjargon. Stef is geen programmeur.

---

## 1. PUSHEN — de belangrijkste regel

**Push nooit iets naar GitHub zonder een duidelijk "ja" van Stef in de chat, voor precies die versie.**

Zo gaat elke update:

1. Stef vraagt iets: een bug, een wens of een screenshot.
2. Je bouwt het. Daarbij hoort ook de versieverhoging (zie §3) en `node deckhand-check.js`, met als uitslag **"Alles GOED"**.
3. Je legt het voor **zonder te pushen**. Je bericht bevat:
   - wat er veranderd is, in gewone taal;
   - de bottom-up check (§5);
   - de changelog-bullets in EN en NL;
   - welke bestanden je pusht (normaal: `index.html`, `sw.js`, `version.json`);
   - het commitbericht, bijvoorbeeld `Deckhand 1.74 — <korte samenvatting>`;
   - de vraag: **"Zal ik 1.74 naar GitHub zetten?"**
4. Alleen een duidelijk "ja" of "push maar" telt. Vraagt Stef eerst nog iets anders, dan begin je opnieuw bij stap 2 en vraag je opnieuw.
5. Na het "ja":
   - `git fetch`, en controleer dat `origin/main` niet veranderd is sinds je begon. Is hij wel veranderd, stop dan en vertel het Stef. Overschrijf nooit zijn werk.
   - Daarna één commit met de bestanden en een gewone `git push` naar `main`.
6. Bevestig met de commit-link. Netlify zet het daarna binnen een paar minuten live.

Dit doe je nooit:
- force-pushen of de geschiedenis herschrijven;
- branches of bestanden verwijderen;
- andere bestanden aanraken dan de drie hierboven zonder Stefs akkoord (ook `CLAUDE.md`, `deckhand-check.js` en `netlify/`);
- iets doen zonder dat Stef erom vraagt;
- geplande taken maken zonder dat Stef erom vraagt.

Eén release per antwoord: één versieverhoging, ook als er meerdere fixes in zitten.

---

## 2. Wijzigingen maken

- **Edits via Python-patches** met string-vervanging. Elke vervanging krijgt eerst `assert s.count(anker) == 1`; vervang nooit blind.
- Patch-scripts horen niet in de repo. Zet ze in een tijdelijke map buiten de repo en gebruik paden ten opzichte van de repo-root.
- Lees altijd de **huidige** `index.html` in de repo. Werk nooit vanuit een herinnerde versie. Kijk eerst naar `APP_VERSION`.
- Voordat je iets in een bestaande container zet: lees eerst de CSS van díe container (flex-richting, scrollgedrag). Leid dat nooit af uit code in de buurt.
- Meet in de browser (Playwright, 412px breed) in plaats van te redeneren over cascade of volgorde. De sandbox kan Scryfall en EDHREC meestal niet bereiken; test dan met mocks.

---

## 3. Versie en changelog (elke release)

- **Versievorm `major.minor`** (1.73 → 1.74; een grote update gaat naar 2.0). Een derde getal bestaat niet.
- **In lockstep:**
  - `APP_VERSION = 'X.Y'` in index.html;
  - `const VERSION = 'admiral-vX.Y'` in sw.js;
  - `"version": "X.Y"` in version.json.
- **`APP_DATE`** wordt de datum van vandaag (JJJJ-MM-DD).
- **Changelog, cumulatief:**
  1. Zet de vorige `CHANGELOG_NOTES` als nieuw item **bovenaan** `CHANGELOG_HISTORY`: `{ v: '<vorige>', d: '<datum>', en: [...], nl: [...] }`.
  2. Schrijf de nieuwe `CHANGELOG_NOTES` in EN en NL.
  3. Elke bullet heeft **maximaal 40 tekens** en noemt alleen wat de speler merkt. Geen uitleg en geen techniek; de uitleg hoort in je bericht aan Stef.
- **`version.json`** bevat dezelfde notities als `CHANGELOG_NOTES`:
  `{ "version": "X.Y", "date": "JJJJ-MM-DD", "notes": { "en": [...], "nl": [...] } }`.
  Het bestand wordt meegecommit. Stuur Stef nooit een .json-bestand om te downloaden; zijn telefoon blijft daarop hangen.
- **Rondleiding (`tourSteps()`) en Over Deckhand (`aboutHtml()`):** alleen aanpassen bij een echt nieuwe, grote feature, altijd in EN én NL. Haal wel een zin weg die niet meer klopt.

---

## 4. Vaste regels van de app

- **Feedback-adres.** Stefs e-mailadres mag **nooit heel** in index.html of sw.js staan. Het wordt in `fbMailto` in stukjes opgebouwd met `[...].join('@')`. De check controleert dit.
- **Opslag.** Het voorvoegsel `admiral_app:` is onaantastbaar. Bestaande sleutels hernoem je nooit.
- **Scryfall.** De wachtrij is strikt serieel (`sfFetch`, ongeveer 80 ms tussen verzoeken, een hoge en een lage prioriteit). Voer nooit twee lanen tegelijk in. Alle POSTs naar `/cards/collection` gaan via `postWithTimeout` (6 s).
- **Modi gescheiden.** Admiral heeft een blauwe vloot: 60 kaarten, singleton, geen lands en een eigen banlijst. Commander heeft een rode vloot: 100 kaarten en de officiële legaliteit van Scryfall. Banlijst, deckpool en woorden lopen nooit door elkaar.
- **Similar = Budget.** Budget Alternatives is Similar cards met een prijsgrens. Een wijziging aan Similar geldt ook voor Budget (`SIM_POINTS`), tenzij Stef iets anders zegt.
- **Kleurenwet.**
  - Per kleurencombinatie zijn er zeven kleuren: main, main licht, main donker, sub, sub licht, sub donker en goud (vlak).
  - Gebruik geen nieuwe kleuren. Geen donker op donker en geen licht op licht.
  - Pas altijd de tekst of het icoon aan, nooit de achtergrond.
- **APK.** De Android-app komt uit `deckhand-android.zip`, en een GitHub-actie bouwt `Deckhand.apk`. Bij een nieuwe APK is de volgorde: eerst de zip, dan wachten tot de build groen is, en pas daarna index.html met `APK_LATEST`.

---

## 5. Bottom-up — controleer dit bij ELKE nieuwe of verplaatste UI

De hele app is onderaan verankerd:
- de navigatiebalk staat onderaan;
- pagina's openen aan de voet;
- inhoud scrolt omhoog;
- filterpanelen zijn drop-up sheets;
- de volgorde van secties is omgedraaid.

Controleer alle vier, en **schrijf de controle in je bericht aan Stef**:

1. **Markup-volgorde.** In een `column-reverse`-container staat wat als eerste in de DOM staat aan de VOET. De belangrijkste inhoud schrijf je dus als eerste.
2. **JS-invoeging.** `appendChild` op een omgedraaide container komt visueel BOVENAAN terecht. Om aan de voet te komen gebruik je `insertBefore(el, parent.firstChild)`. Controleer altijd eerst de flex-richting.
3. **Viewport.** Een paneel, pagina of menu dat opengaat, laat de ONDERKANT zien (`scrollToPageFoot()` of iets vergelijkbaars).
4. **Spacers en kopieën.** Een onzichtbare spacer of ghost-element met een bestaande class erft die marges, bijvoorbeeld `margin-top:auto`. Geef ze expliciete marges.

---

## 6. Controleren vóór je iets voorlegt

```
node deckhand-check.js
```

Dit script controleert:
- `node --check` op het app-script in index.html en op sw.js;
- de versies in lockstep, plus de vorm `major.minor`;
- dat het feedback-adres nergens heel staat;
- de changelog: max 40 tekens per bullet, EN en NL, version.json gelijk aan `CHANGELOG_NOTES`, de historie bijgewerkt;
- de browsertests (Playwright, telefoonformaat, offline), elk met de uitslag n/n.

Bij **elke "FOUT": niet voorleggen en niet pushen.** Eerst repareren.

Kunnen de browsertests niet draaien omdat Playwright of Chromium ontbreekt? Probeer dan:
```
npm i --no-save playwright && npx playwright install chromium
```
Lukt dat ook niet, zeg het Stef dan eerlijk en vraag of hij toch wil pushen.

---

## 7. Over deze werkwijze

- De projectdocumenten in claude.ai (project "A&C MTG") zijn de uitgebreide achtergrond. Dit bestand vat de regels samen voor Claude Code-sessies.
- Netlify zet ook dit bestand en `deckhand-check.js` online, omdat ze in de repo-root staan. Er staat niets geheims in.
