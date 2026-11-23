# Konfiguration

OpenStatusPage wird an zwei Stellen konfiguriert:

- **Umgebungsvariablen** für alles, was den Server und seine Umgebung betrifft
  (URLs, Geheimnisse, Datenbank, Anmeldung, E-Mail). Sie werden beim Start
  gelesen; nach einer Änderung startest du die Anwendung neu.
- **Die Einstellungsseite** in der Verwaltung (**Administration →
  Einstellungen**, nur für Administratoren) für alles, was Besucher sehen.
  Änderungen gelten sofort.

## Umgebungsvariablen

Die vollständige Referenz aller Optionen steht in
[`docs/configuration.md`](../../configuration.md) (Englisch), eine
kommentierte Vorlage in [`.env.example`](../../../.env.example). Die
wichtigsten Variablen:

| Variable | Standard | Hinweise |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Öffentliche URL ohne abschließenden Schrägstrich. Siehe [Reverse Proxy](03-reverse-proxy.md#base_url). |
| `PUBLIC_BASE_URL` | `BASE_URL` | Getrennter Betrieb: die öffentliche URL auf Admin- und Worker-Instanzen, für alle Links in E-Mails und Feeds. Auch die Daten für Suchmaschinen (kanonische Links, Sitemaps, `robots.txt`, `llms.txt`) verwenden sie. |
| `SECRET_KEY` | – | Im Produktivbetrieb Pflicht, mindestens 32 Zeichen und kein Beispielwert aus der Dokumentation. Siehe [Betrieb](09-operations.md#secret_key). |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<Pfad>` oder `postgres://benutzer:passwort@host:5432/datenbank`. |
| `TRUST_PROXY` | `false` | Anzahl der Reverse Proxys vor der Anwendung oder deren Adressen. Siehe [Reverse Proxy](03-reverse-proxy.md#trust_proxy). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Schnittstelle und Port, auf denen der Server lauscht. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` oder `silent`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | Erster Administrator, nur solange es keinen Benutzer gibt. |
| `SESSION_TTL_HOURS` | `168` | Inaktivität, nach der eine Anmeldung abläuft (gleitend). |
| `SESSION_MAX_AGE_HOURS` | `720` | Maximale Dauer einer Anmeldung ab dem Login, auch bei Aktivität (mindestens `SESSION_TTL_HOURS`). |
| `LOCAL_LOGIN_ENABLED` | `true` | `false` erlaubt nur noch Single Sign-On. |
| `OIDC_*` | – | Single Sign-On mit dem Anbieter aus der Umgebung. Weitere Anbieter legst du unter *Administration → Single Sign-On* an; siehe [Benutzer und Zugriff](08-users-and-access.md#single-sign-on-oidc). |
| `APP_ROLE` | `all` | `all`, oder mit PostgreSQL `public`, `admin` bzw. `worker`, wenn du Statusseite und Verwaltung als getrennte Instanzen betreibst. Siehe [Getrennter Betrieb](../../configuration.md#split-deployment). |
| `DB_PUBLIC_ROLE` | `osp_public` | PostgreSQL-Login der `public`-Instanz. Sie darf nur öffentliche Daten lesen und Abonnements über geprüfte Funktionen verwalten. Lege die Rolle mit `deploy/postgres/roles.sql` an; siehe [Sicherheitsmodell](../../security-model.md). |
| `WORKER_ENABLED` | `true` (`false` bei `APP_ROLE=admin`) | Hintergrundaufgaben; mit PostgreSQL dürfen mehrere Instanzen sie ausführen (Abstimmung über die Datenbank). |
| `POLL_MAX_RESPONSE_MB`, `POLL_MAX_VALUES`, `MAX_CHECKS_PER_SOURCE` | `8`, `500000`, `20000` | Grenzen pro Antwort einer Abfrage und pro Monitoring-Quelle, passend zur Speichergrenze des Images. Siehe [Monitoring anbinden](05-monitoring.md#tipps). |
| `UMAMI_URL` | – | Dein Umami-Server für Statistiken über Seitenaufrufe, siehe [Statistik mit Umami](#statistik-mit-umami). |
| `MAIL_TRANSPORT`, `SMTP_*` | – | E-Mail-Versand, siehe [E-Mail-Abonnements](07-email-subscriptions.md#mailserver). |

Für alle Variablen gilt:

- Eine `.env`-Datei im Arbeitsverzeichnis oder im Wurzelverzeichnis des
  Repositorys (oder die Datei aus `ENV_FILE`) wird automatisch geladen;
  Variablen, die schon in der Umgebung gesetzt sind, haben Vorrang.
- Leere Werte gelten als nicht gesetzt.
- Boolesche Werte akzeptieren `true`/`false`, `1`/`0` und `yes`/`no`.
- Ungültige Werte stoppen den Server beim Start mit einer Liste der
  betroffenen Variablen.
- `NODE_ENV` ist standardmäßig `production`. Nur für die lokale Entwicklung
  nimmst du `development` (`pnpm dev` setzt das): Dann darf `SECRET_KEY`
  fehlen und die Logs sind für Menschen formatiert.

Bei Docker Compose kommt jede Variable in `.env` neben `compose.yaml`; die
ganze Datei landet im Container, und `docker compose up -d` übernimmt eine
Änderung (siehe [Installation](02-installation.md#einstellungen-in-env)).
`compose.yaml` setzt selbst `DATABASE_URL`, `SECRET_KEY`, `HOST` und `PORT`
sowie die Mail-Variablen `SMTP_HOST`, `SMTP_FROM` und `MAIL_DKIM_DIR`, wenn
`MAIL_DOMAIN` gesetzt ist (ein Wert in `.env` gewinnt). Die Variablen des
mitgelieferten Mailservers stehen in der
[Konfigurationsreferenz](../../configuration.md#email-notifications). Unter Kubernetes kommen die
Variablen in das Secret `openstatuspage` oder in die `env:`-Liste von
`deployment.yaml`.

## Die Einstellungsseite

**Administration → Einstellungen** steuert die öffentliche Seite:

| Bereich | Einstellung | Wirkung |
| --- | --- | --- |
| Branding | Seitenname | Erscheint im Kopf der Seite, im Browser-Titel, in Feeds und im Betreff von E-Mails. |
| Branding | Beschreibung | Kurzer Text unter dem Seitennamen. |
| Branding | Logo-URL, Favicon-URL | `https://`-URLs oder Pfade, oder *Logo hochladen* / *Favicon hochladen*, um ein Bild auf dieser Instanz zu speichern (PNG, JPEG, WebP oder ICO, höchstens 1 MB, kein SVG). |
| Branding | Akzentfarbe (ersetzt die des Themes) | Optional. Ersetzt den Akzent des aktiven Themes (Hex, z. B. `#7c6cf2`); leer: der Akzent des Themes. Wird für ausreichenden Kontrast automatisch angepasst, siehe [unten](#akzentfarbe-und-barrierefreiheit). |
| Darstellung | Administration → Darstellung | Das Theme der öffentlichen Seite: Farben, Ecken, Schriften und Abstände, siehe [Themes](#themes). |
| Anzeige | Standardsprache | Gilt, wenn die Browsersprache des Besuchers nicht verfügbar ist (Englisch oder Deutsch). |
| Anzeige | Standarddarstellung | System, hell oder dunkel; Besucher können umschalten. |
| Anzeige | Support-URL | Optionaler Link zu deiner Support- oder Kontaktseite. |
| Anzeige | Standorte anzeigen | Zeigt die Standortseite und die Karte. |
| Anzeige | Verfügbarkeit anzeigen | Zeigt Verfügbarkeitsbalken und Prozentwerte. |
| Anzeige | Tage der Verfügbarkeit | Tage in den Verfügbarkeitsbalken (7–180, Standard 90). |
| Anzeige | Tage für kürzliche Vorfälle | Wie lange behobene Vorfälle in der Übersicht bleiben (1–90, Standard 7). |
| Footer-Links | – | Bis zu 10 weitere Links im Footer. |
| Inhaltsseiten | Administration → Seiten | Über diese Seite, Impressum, Datenschutz, Erklärung zur Barrierefreiheit und eigene Seiten, in Markdown je Sprache. Eine veröffentlichte Standardseite ersetzt ihren Link oben; siehe [Inhaltsseiten und Bilder](12-public-page.md#inhaltsseiten-und-bilder). |
| E-Mail-Abonnements | E-Mail-Abonnements anbieten | Bietet Abonnements auf der öffentlichen Seite an (setzt einen konfigurierten Mailserver voraus). Standard: aus. |
| E-Mail-Abonnements | Wartungserinnerung (Stunden) | Stunden vor einer geplanten Wartung, zu denen Abonnenten erinnert werden (0–168, 0 = aus, Standard 24). |
| Rechtliche Links | Impressum, Datenschutz, Erklärung zur Barrierefreiheit | `https://`-Links zu diesen Seiten auf deiner Website, jeweils mit optionaler Bezeichnung; erscheinen im Footer unter „Rechtliches“, ohne URL ausgeblendet. Gilt nicht für eine Standardseite, die unter Seiten veröffentlicht ist. |
| Copyright und Hinweis | Copyright-Hinweis | Reiner Text wie `© {year} Beispiel GmbH`; `{year}` wird zum aktuellen Jahr. Leer: `© <Jahr> <Seitenname>`. |
| Copyright und Hinweis | URL des Marken-Links | Optional; macht den Hinweis zu einem Link auf deine Website. |
| Copyright und Hinweis | „Betrieben mit OpenStatusPage“ anzeigen | Zeigt den Hinweis auf die Software. Standard: an. |
| Info-Link | Bezeichnung, URL oder Pfad | Optionaler zusätzlicher Eintrag in der Navigation, z. B. „Was bedeutet der Status?“. Eine `https://`-URL oder ein Pfad auf dieser Seite wie `/about`. Gilt nicht, sobald die Seite „Über diese Seite“ unter Seiten veröffentlicht ist (die Bezeichnung bleibt). |
| Link-Tracking (UTM) | UTM-Parameter anhängen, utm_source, utm_medium, utm_campaign | Hängt die Parameter an die Links oben an, die zu anderen Websites führen, siehe [unten](#utm-parameter). Standard: aus. |

Die E-Mail-Einstellungen und den Kasten **E-Mail-Versand** darunter erklärt
[E-Mail-Abonnements](07-email-subscriptions.md).

### Akzentfarbe und Barrierefreiheit

Die öffentliche Seite und die E-Mails sollen WCAG 2.2 Stufe AA erfüllen (siehe
`docs/accessibility.md` im Repository). Du kannst jede Akzentfarbe wählen; die
Seite hält sie selbst lesbar:

- Links, hervorgehobener Text und der Tastatur-Fokusrahmen nutzen eine Variante
  deiner Farbe, die gerade so weit abgedunkelt (helle Darstellung) oder
  aufgehellt (dunkle Darstellung) wird, dass sie auf jedem Hintergrund einen
  Kontrast von 4,5:1 erreicht.
- Buttons in deiner Farbe bekommen weiße oder dunkle Schrift, je nachdem, was
  lesbar ist, und die Farbe wird bei Bedarf leicht abgedunkelt. Die E-Mails
  machen das für ihren Button genauso.

Eine sehr helle Farbe wie Gelb wirkt auf der Seite deshalb dunkler als in der
Farbauswahl. Am nächsten an deiner Markenfarbe bleibst du mit einer mittleren
oder dunklen Farbe. Prüfe die Seite in heller und dunkler Darstellung und
verzichte auf Logos, die außer dem Seitennamen wichtigen Text enthalten (das
Logo hat keinen Alternativtext, weil der Seitenname daneben steht). Schreib
Texte zu Vorfällen und Wartungen in der Sprache der meisten Besucher.

Sprache und Darstellung der Verwaltung stellt jeder Benutzer selbst im
Benutzermenü (unten links) ein.

### Themes

**Administration → Darstellung** listet die Themes der öffentlichen Seite mit
ihrer Quelle: *Eingebaut* (`OpenStatusPage`, der Standard, dazu `Slate`,
`Forest` und `High contrast`), *Themes-Ordner* (Dateien auf dem Server, beim
Start gelesen) und *Hochgeladen*. Alle eingebauten Themes erfüllen WCAG 2.2 AA
in heller und dunkler Darstellung.

- **Vorschau** (Auge) zeigt ein Beispiel der öffentlichen Seite mit dem Theme,
  hell und dunkel nebeneinander. **Öffentliche Seite ansehen** öffnet die
  echte Seite mit dem Theme in einem neuen Tab; nur du siehst sie (angemeldete
  Admins), Besucher behalten das aktive Theme.
- **Aktivieren** macht es zum Theme der öffentlichen Seite. Ein Theme mit
  Kontrastproblemen verlangt eine Bestätigung mit **Trotzdem aktivieren** und
  wird erst danach aktiviert; der Editor nennt die betroffenen Farbpaare, besser
  korrigierst du die Farben. Wird das aktive Theme so geändert, dass es
  durchfällt, fragt der Editor nach **Trotzdem speichern**.
  Fällt das aktive Theme ohne Bestätigung durch (seine Datei im Ordner hat sich
  vor einem Neustart geändert, oder die Akzentfarbe in den Einstellungen), nennt
  es ein Hinweis oben auf der Seite, und **Prüfen** fragt nach derselben
  Bestätigung; im Server-Log steht zusätzlich eine Warnung.
- **Theme importieren** nimmt eine Theme-Datei (`<id>.json`) und optional ihr
  zusätzliches CSS (`<id>.css`). **Kopie anpassen** öffnet den Editor mit einer
  Kopie eines eingebauten Themes oder eines Themes aus dem Ordner; hochgeladene
  Themes kannst du bearbeiten und löschen. Der Editor hat für jedes Token eine
  Farbauswahl, prüft den Kontrast beim Tippen und zeigt die Vorschau.
- Mit dem Download-Knopf speicherst du jedes Theme als JSON, etwa für den
  Themes-Ordner einer anderen Installation.

Zusätzliches CSS wird gefiltert: kein `@import`, keine Bilder oder Schriften von
anderen Websites (nur Uploads dieser Instanz oder relative Pfade dieser Seite), nichts, was nach HTML oder einem
Skript aussieht. Das Dateiformat, alle Tokens und die Einrichtung des
Themes-Ordners für Docker Compose, Helm und eine Installation ohne Container
beschreibt `docs/themes.md` im Repository.

### Rechtliche Links und Info-Link

Die rechtlichen Links zeigen auf Seiten deiner eigenen Website; die Statusseite
hat keinen Editor dafür. Jede öffentliche Seite zeigt sie im Footer, auch ohne
JavaScript. Links zu anderen Websites öffnen sich in einem neuen Tab, und
Screenreader sagen das an. Der Info-Link kann auch ein Pfad auf dieser Seite
sein (`/about`), etwa eine Seite, die dein Reverse Proxy ausliefert; so ein Pfad
muss mit einem einzelnen `/` beginnen, damit der Link nie zu einem anderen Host
führen kann.

### UTM-Parameter

Ist **UTM-Parameter an ausgehende Links anhängen** eingeschaltet, hängt die
Seite `utm_source`, `utm_medium` und `utm_campaign` (die, die du ausgefüllt
hast) an jeden von dir eingetragenen Link zu einer anderen Website an:
rechtliche Links, Marken-Link, Info-Link, Support-URL, Footer-Links und die
Websites der Services. Deine Webanalyse sieht dann, dass Besuche von der
Statusseite kamen. Links auf die Adresse der Statusseite selbst und Links, die
schon einen `utm_`-Parameter enthalten, bleiben unverändert. Den Rest einer
Link-Adresse lässt die Seite in Ruhe: Sie hängt die UTM-Parameter nur hinten an
die Query an, vor einem `#Fragment`.

Ihre eigene Adresse kennt die Seite aus `PUBLIC_BASE_URL` (oder `BASE_URL`, wenn
das nicht gesetzt ist). Hinter einem Reverse Proxy muss das die Adresse sein,
die Besucher wirklich aufrufen. Stimmt sie nicht, gelten Links auf die
Statusseite selbst als Links zu einer anderen Website: Sie bekommen
UTM-Parameter, öffnen sich in einem neuen Tab und werden so angekündigt.

### Statistik mit Umami

Die Statusseite kann Seitenaufrufe mit [Umami](https://umami.is) zählen, einem
Analyse-Server, den du selbst betreibst und der keine Cookies setzt. Du
brauchst Umami 2.0 oder neuer. Zwei Schritte:

1. Setze `UMAMI_URL` auf die Adresse deines Umami-Servers (zum Beispiel
   `https://umami.example.com` oder `http://umami:3000` in einem
   Docker-Netzwerk) auf jeder Instanz, die die Statusseite ausliefert, und
   starte sie neu. Bei getrennten Instanzen ist das die `public`-Instanz (und
   die `admin`-Instanz für ihre Vorschau).
2. Lege in Umami eine Website an und kopiere ihre **Website ID**. Schalte unter
   **Einstellungen → Statistik (Umami)** **Seitenaufrufe mit Umami zählen** ein
   und füge die ID ein. Hat der Server, den du gerade verwaltest, keine
   `UMAMI_URL`, warnt dich die Karte, dass der Schalter dort nichts bewirkt.

Die Browser der Besucher sprechen nie mit Umami. Die Statusseite liefert den
Tracker als `/pulse/p.js` aus und gibt die Ereignisse von `/pulse/api/send` an
Umami weiter. Dein Umami-Server kann also intern bleiben, und die Seite braucht
keine Ausnahme in ihrer Sicherheitsrichtlinie. Die Adresse des Umami-Servers ist
absichtlich eine Umgebungsvariable und keine Einstellung: Wer nur Zugriff auf die
Verwaltung hat, kann den Server nicht anderswohin verbinden lassen.

Was Besucher und deine Statistik bekommen:

- Jede öffentliche Seite hat im Footer neben der Datenschutzerklärung
  **Statistik deaktivieren**. Das funktioniert ohne JavaScript und speichert die
  Wahl ein Jahr lang im Cookie `osp-analytics`; danach steht dort „Statistik ist
  deaktiviert.“ mit **Statistik aktivieren**. Dieses Cookie entscheidet immer:
  Läuft es ab oder wird es gelöscht, zählt die Seite wieder und zeigt das auch
  im Footer.
- Abo-Links aus E-Mails werden nie gezählt, und Tokens (mit der Abo-ID daneben)
  und `#Fragmente` werden aus jeder Adresse entfernt, bevor sie Umami erreicht. Die Verwaltung wird nie gezählt.
- **Do Not Track und Global Privacy Control beachten** (standardmäßig an) sendet
  nichts für Browser, die darum bitten, nicht erfasst zu werden.
- **IP-Adressen der Besucher an Umami weitergeben** ist standardmäßig aus. Umami
  sieht dann nur deinen Statusseiten-Server: Es zeigt keine Standorte der
  Besucher (oder den des Servers) und zählt Besucher mit derselben
  Browserversion als einen; die Besucherzahlen sind dann zu niedrig, die
  Seitenaufrufe stimmen. Schalte es nur ein, wenn deine Datenschutzerklärung das
  abdeckt, und setze hinter einem Reverse Proxy `TRUST_PROXY` (siehe
  [Reverse Proxy](03-reverse-proxy.md#trust_proxy)), sonst bekommt Umami die
  Adresse des Proxys.
- **Nur auf diesen Domains** beschränkt das Zählen auf die Hostnamen, die du
  einträgst, etwa um eine Testkopie auszunehmen.

Ist Umami nicht erreichbar oder langsam, funktionieren die Seiten ohne Fehler
weiter; der Statistik fehlen dann nur diese Aufrufe. Die Website ID steht in
jeder Seite, daher könnte jeder erfundene Aufrufe senden, wie bei jeder
Umami-Installation; nimm die Zahlen als Trend, nicht als genaue Zählung. Erwähne die Statistik in deiner
Datenschutzerklärung. Details und Grenzen:
[configuration.md](../../configuration.md#analytics).

## Die wirksame Konfiguration prüfen

Eine Seite, die die Umgebung ausgibt, gibt es absichtlich nicht. So prüfst du
einen Wert:

- Das Log beim Start meldet Konfigurationsfehler und warnt vor einem
  unsicheren `SECRET_KEY` oder einer riskanten OIDC-Einstellung.
- Der Kasten **E-Mail-Versand** auf der Einstellungsseite zeigt Versandart
  und Absender
  (siehe [E-Mail-Abonnements](07-email-subscriptions.md#fehlersuche)).
- `docker compose exec openstatuspage env` zeigt, was tatsächlich im
  Container ankommt (enthält Geheimnisse, also nirgends einfügen).
