# Ein Theme erstellen

Dieses Kapitel zeigt Schritt für Schritt, wie du ein eigenes Theme für die
öffentliche Statusseite erstellst. Du startest mit der Vorlage, passt die
Farben an, prüfst den Kontrast, schaust dir das Ergebnis an und installierst
das Theme. Die vollständige Referenz steht in [Themes](../../themes.md); die
Dateien sind in [contrib/themes](../../../contrib/themes/README.md) beschrieben.

## Für wen ist das?

- Administratoren, die die Statusseite an ihre Marke oder ihre Website anpassen
  möchten, ohne den Code zu ändern.
- Wer mehrere Installationen betreut und dieselbe Theme-Datei auf allen nutzen
  will.

Du musst kein CSS kennen. Ein Theme ist eine JSON-Datei mit Farben, einem
Eckenradius, Schriftnamen und einer Dichte. Zusätzliches CSS ist optional.

## Schritt für Schritt

### 1. Mit einer Vorlage beginnen

Du hast zwei Wege:

- **Vorlage:** lade `starter.json` (und optional `starter.css`) aus
  [contrib/themes](../../../contrib/themes/README.md) herunter. Jede Farbe ist
  gesetzt, auch die optionalen, sodass du alle Tokens auf einmal siehst.
- **Kopie anpassen:** klicke in **Administration → Darstellung** bei einem
  eingebauten Theme oder einem Theme aus dem Ordner auf das Kopier-Symbol
  (beschriftet mit **Kopie von „…“ anpassen**). Der Editor öffnet sich mit allen
  Werten, die du dort ändern kannst. Hochgeladene Themes haben kein
  Kopier-Symbol: Bearbeite sie direkt, oder lade das JSON herunter, ändere die
  `id` und importiere es als neues Theme.

Vergib vor dem Speichern eine neue **ID**. Die ID ist der Name des Themes und
zugleich der Dateiname (`mein-theme.json`). Sie darf 1 bis 48 Zeichen lang sein
und aus Kleinbuchstaben, Ziffern und Bindestrichen bestehen. Sie **lässt sich
später nicht ändern**. Eine ID, die schon vergeben ist, wird abgelehnt:
`default`, `slate`, `forest` und `high-contrast` sind belegt, ebenso die ID
jedes installierten Themes.

Gib dem Theme einen `name` (er steht in der Liste der Administration) und
optional einen `author` und eine `description`.

```json
{
  "id": "mein-theme",
  "name": "Mein Theme",
  "version": 1,
  "author": "Beispiel GmbH",
  "description": "Unsere Markenfarben auf der Statusseite."
}
```

`version` ist immer `1`.

### 2. Farben für den hellen und den dunklen Modus setzen

Die Farben stehen in zwei Blöcken, `light` (hell) und `dark` (dunkel). Beide
Blöcke haben dieselben Tokens. Die wichtigsten sind:

| Token | Was er einfärbt |
| --- | --- |
| `background` | Der Seitenhintergrund |
| `surface` | Karten und Kopfbereich |
| `surfaceAlt` | Einschübe, Tabellenköpfe, Hover-Hintergründe |
| `border` | Trennlinien zwischen Einträgen |
| `borderStrong` | Rahmen von Eingabefeldern und Schaltflächen |
| `text` | Fließtext |
| `muted` | Nebentext |
| `accent` | Deine Markenfarbe, ausgewählte Zustände, Links |
| `status` | Die fünf Statusfarben und die Farbe für Tage ohne Daten (`noData`) |

```json
"light": {
  "background": "#f7f7f8",
  "surface": "#ffffff",
  "surfaceAlt": "#efeff2",
  "border": "#dcdce2",
  "borderStrong": "#71717a",
  "text": "#18181b",
  "muted": "#52525b",
  "accent": "#0e7490",
  "status": {
    "operational": "#15803d",
    "maintenance": "#2563eb",
    "degraded": "#a16207",
    "partialOutage": "#c2410c",
    "majorOutage": "#dc2626",
    "noData": "#71717a"
  }
}
```

Verwende nur undurchsichtige Farben in einer dieser Schreibweisen: `#rgb`,
`#rrggbb`, `rgb(20 80 120)`, `rgb(20, 80, 120)`, `hsl(200 60% 30%)` oder
`oklch(0.45 0.1 230)`. Transparenz (Alpha), Farbnamen wie `navy` und `var(...)`
werden abgelehnt.

Am einfachsten gehst du so vor: Fülle zuerst `light` aus, kopiere den Block
nach `dark` und passe die Farben dort an. Der dunkle Modus braucht meist hellere
Texte und Statusfarben und dunklere Flächen.

Optional kannst du `focus` (der Fokusrahmen) und `statusText` (Text und Symbole
des Status) setzen. Lässt du sie weg, werden sie aus den anderen Farben
abgeleitet. Die Vorlage zeigt beides.

### 3. Den Kontrast prüfen

Jedes Theme wird im hellen und im dunklen Modus gegen **WCAG 2.2 AA** geprüft.
Kurz gesagt:

- Text (`text`, `muted`) und die Statustextfarben (`statusText.*`, falls
  gesetzt) brauchen gegenüber Hintergrund, Karten- und Einschubfarbe mindestens
  ein Kontrastverhältnis von **4,5 : 1**.
- Bedienelemente und Statusflächen (`borderStrong`, `accent`, `focus`,
  `status.*`) brauchen mindestens **3 : 1**.
- Der Text auf gefüllten Akzent-Knöpfen braucht mindestens **4,5 : 1**. Er
  erscheint als `accentButtonText auf accentButton`. Die Knopffarbe wird aus
  `accent` abgeleitet, ändere also `accent`, um das zu beheben.
- Dekorative Trennlinien (`border`) werden nicht geprüft.

Der Editor zeigt den Kontrast live unter **Kontrast und Vorschau**. Ein
fehlgeschlagenes Paar sieht so aus:

```text
Hell: muted auf surface 2.40:1 (nötig 4.5:1)
```

Das heißt: Im hellen Modus hat der Nebentext `muted` auf der Kartenfarbe
`surface` ein Verhältnis von 2,40 zu 1, nötig sind aber mindestens 4,5 zu 1. Mach `muted`
dunkler (oder `surface` heller) und prüfe erneut. Die Meldung nennt den Modus,
den Vordergrund und den Hintergrund, du weißt also, welches Token du ändern
musst.

In der Liste der Administration steht **Erfüllt AA**, wenn alles stimmt, sonst
die Anzahl der Probleme.

### 4. Optional: Radius, Schriften und Dichte

- **`radius`**: der Basisradius der Ecken: `0` oder eine Länge bis `2rem` bzw.
  `32px` (zum Beispiel `0.5rem`, der Standard). Größere und kleinere Ecken
  skalieren mit.
- **`fonts`**: nur Schriften, die auf dem Gerät des Besuchers **installiert**
  sind. Es wird nichts nachgeladen, also keine Webfonts und kein CDN. Eine
  Schriftliste besteht aus Familiennamen, durch Kommas getrennt, und endet mit
  einer generischen Familie:

  ```json
  "fonts": {
    "sans": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  }
  ```

- **`density`**: `compact` (90 % Abstand), `comfortable` (der Standard) oder
  `spacious` (110 %).

### 5. Optional: zusätzliches CSS

Zusätzliches CSS ist für alles gedacht, was die Tokens nicht können, etwa eine
Linie unter dem Kopfbereich. Lege es als Datei `mein-theme.css` an (gleicher
Name wie die JSON-Datei) oder trage es im Feld **Zusätzliches CSS** des Editors
ein. Die Vorlage enthält in `starter.css` ein kommentiertes Beispiel.

```css
header {
  border-bottom: 3px solid var(--accent);
}
```

Verwende die Variablen des Themes (`var(--accent)`, `var(--surface)`,
`var(--fg)`, `var(--muted)`, `var(--border)`) statt fester Farben, dann
funktioniert die Regel im hellen und im dunklen Modus.

Der Filter **lehnt die ganze Datei ab** (sie wird nie umgeschrieben), wenn er
findet:

- mehr als 64 KB;
- `@import`;
- `url()` auf etwas anderes als `/uploads/...` (in der Administration
  hochgeladene Bilder) oder einen relativen Pfad auf derselben Seite (ohne `..`
  und ohne Abfrageteil). Kein anderer Host, kein `//host`, kein `data:`;
- `expression()`, `javascript:` oder `vbscript:`, `behavior`, `-moz-binding`,
  `image-set()` und `src()`;
- die Zeichen `<` und `-->`, auch in Kommentaren;
- Steuerzeichen und ein nicht geschlossener Kommentar.

Zusätzliches CSS kann jede Stelle der Seite verändern. Die Kontrastprüfung
betrachtet nur die Tokens. Prüfe das Ergebnis deshalb immer mit der Vorschau
(Schritt 6).

### 6. Mit der Vorschau testen

Es gibt zwei Vorschauen:

- **Vorschau** in der Liste der Administration (bzw. die Live-Vorschau im
  Editor) zeigt ein Muster der öffentlichen Seite im hellen und im dunklen
  Modus.
- **Öffentliche Seite mit „…“ ansehen** öffnet die echte Seite mit deinem Theme
  in einem neuen Tab, etwa `/?theme=mein-theme`. Nur du siehst sie, denn der
  Server beachtet `?theme=` nur für angemeldete **Admins**. Besucher behalten
  das aktive Theme.

Prüfe die Seite in beiden Modi, mit einem langen Namen eines Dienstes, einer
Störung und einem Tag ohne Daten. Schau sie dir danach auch auf dem Telefon an.

### 7. Das Theme installieren

Es gibt drei Wege. Wähle den, der zu deinem Betrieb passt.

**Hochladen in der Administration (am einfachsten):** Klicke unter
**Administration → Darstellung** auf **Theme importieren**. Wähle
`mein-theme.json` und optional `mein-theme.css`. Das Theme wird in der Datenbank
gespeichert und kann in der Administration bearbeitet werden.

**Themes-Ordner:** Lege die Dateien in den Themes-Ordner und starte den Server
neu. Die Dateinamen müssen zur ID passen: `mein-theme.json` und
`mein-theme.css`. Themes aus dem Ordner kannst du in der Administration nicht
bearbeiten, wohl aber herunterladen und anderswo installieren.

- Docker Compose: Lege die Dateien in `./themes` neben der Compose-Datei und
  binde den Ordner ein, wie in [Themes](../../themes.md#docker-compose)
  beschrieben. Danach `docker compose up -d`.
- Helm: Trage die Dateien unter `themes.files` in deinen Werten ein (oder nutze
  `themes.existingConfigMap`), siehe den Abschnitt
  [Themes in der Chart-README](../../../deploy/helm/openstatuspage/README.md#themes).
- Ohne Container: Kopiere die Dateien nach `/etc/openstatuspage/themes` und
  mache sie für alle lesbar (`install -m 0644 mein-theme.json mein-theme.css
  /etc/openstatuspage/themes/`). Starte danach `systemctl restart
  openstatuspage` neu (bei einer geteilten Installation `openstatuspage-split.target`).

Der Ordner wird nur beim Start des Servers gelesen. Starte also nach jeder
Änderung neu.

### 8. Das Theme aktivieren

Klicke in **Administration → Darstellung** bei deinem Theme auf **Aktivieren**.
Es wird das Theme der öffentlichen Seite für alle Besucher. Besucher können
weiterhin zwischen hellem und dunklem Modus wechseln.

Besteht das Theme die Kontrastprüfung nicht, fragt **Aktivieren** nach einer
Bestätigung mit **Trotzdem aktivieren**. Nutze das nicht als Abkürzung: Korrigiere
lieber die Farben, denn eine kontrastarme Seite ist für viele Besucher schwer
lesbar.

### 9. Teilen und aktualisieren

- Mit dem Download-Knopf speicherst du ein Theme als JSON (und das zusätzliche
  CSS als `.css`). So bringst du es auf eine andere Installation oder gibst es
  weiter.
- Um ein hochgeladenes Theme zu ändern, öffne es mit dem Bearbeiten-Knopf, ändere
  es und speichere. Ist es das aktive Theme und besteht die neue Fassung die
  Kontrastprüfung nicht, fragt der Editor nach **Trotzdem speichern**.
- Um ein Theme aus dem Ordner zu ändern, bearbeite die Datei auf dem Server und
  starte neu. Für ein eingebautes Theme nutzt du **Kopie anpassen** und vergibst
  der Kopie eine neue ID.
- Behalte die ID bei, wenn du ein Theme aktualisierst. Die ID eines
  hochgeladenen Themes lässt sich nicht ändern.

## Fehlersuche

| Meldung oder Verhalten | Was du tun kannst |
| --- | --- |
| **Das Theme kann nicht gespeichert werden:** mit einer ungültigen Farbe (die Liste nennt das Feld) | Verwende `#rrggbb`, `#rgb`, `rgb()`, `hsl()` oder `oklch()` ohne Transparenz. Farbnamen und `var()` sind nicht erlaubt. |
| Die Liste nennt ein Feld, das du nicht erwartest | Entferne den Schlüssel oder prüfe die Schreibweise. Erlaubt sind nur die Schlüssel aus [Themes](../../themes.md#theme-file-format), auf jeder Ebene (`$schema` ist die einzige optionale Ausnahme). |
| `contrast_failures` (409) oder **Trotzdem aktivieren** erscheint | Lies die fehlerhaften Paare im Editor und mach die Farben dunkler oder heller. Bestätige nur, wenn du das Ergebnis akzeptierst. |
| `A theme with the id "…" exists already` (409) | Wähle eine andere ID. Eingebaute, Ordner- und hochgeladene Themes teilen sich einen ID-Raum. |
| Eine Ordner-Datei wird im Server-Log übersprungen (`Theme file skipped: …`) | Prüfe den Dateinamen (er muss der `id` entsprechen) und das JSON. Das Log nennt den Grund. |
| Das zusätzliche CSS wird abgelehnt | Die Meldung nennt die Regel (etwa `@import is not allowed`) und zeigt einen kurzen Auszug. Entferne die Regel und speichere erneut. |
| Ein Ordner-Theme erscheint nach einer Änderung nicht | Der Ordner wird nur beim Start gelesen: starte den Server neu. |
| Das aktive Theme ist als unbestätigt markiert | Seine Datei oder die Akzentfarbe in den Einstellungen hat sich geändert. Öffne **Darstellung**, klicke auf **Prüfen** und aktiviere es erneut oder korrigiere die Farben. |
| Besucher sehen das Standard-Theme | Das aktive Theme wurde entfernt (etwa eine Ordner-Datei gelöscht). Aktiviere ein anderes Theme. |

## Wie geht es weiter?

- [Themes](../../themes.md) enthält die vollständige Referenz: jedes Token, jede
  Grenze und die Schnittstelle der Verwaltung.
- [Konfiguration](04-configuration.md#themes) beschreibt die Seite Darstellung.
- [contrib/themes](../../../contrib/themes/README.md) listet die Beispiel-Themes
  `ocean` und `starter`.
