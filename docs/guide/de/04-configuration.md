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
| `SECRET_KEY` | – | Im Produktivbetrieb Pflicht, mindestens 32 Zeichen. Siehe [Betrieb](09-operations.md#secret_key). |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<Pfad>` oder `postgres://benutzer:passwort@host:5432/datenbank`. |
| `TRUST_PROXY` | `false` | Anzahl der Reverse Proxys vor der Anwendung oder deren Adressen. Siehe [Reverse Proxy](03-reverse-proxy.md#trust_proxy). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Schnittstelle und Port, auf denen der Server lauscht. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` oder `silent`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | Erster Administrator, nur solange es keinen Benutzer gibt. |
| `SESSION_TTL_HOURS` | `168` | Inaktivität, nach der eine Anmeldung abläuft (gleitend). |
| `SESSION_MAX_AGE_HOURS` | `720` | Maximale Dauer einer Anmeldung ab dem Login, auch bei Aktivität (mindestens `SESSION_TTL_HOURS`). |
| `LOCAL_LOGIN_ENABLED` | `true` | `false` erlaubt nur noch Single Sign-On. |
| `OIDC_*` | – | Single Sign-On, siehe [Benutzer und Zugriff](08-users-and-access.md#single-sign-on-oidc). |
| `APP_ROLE` | `all` | `all`, oder mit PostgreSQL `public`, `admin` bzw. `worker`, wenn du Statusseite und Verwaltung als getrennte Instanzen betreibst. Siehe [Getrennter Betrieb](../../configuration.md#split-deployment). |
| `DB_PUBLIC_ROLE` | `osp_public` | PostgreSQL-Login der `public`-Instanz. Sie darf nur öffentliche Daten lesen und Abonnements über geprüfte Funktionen verwalten. Lege die Rolle mit `deploy/postgres/roles.sql` an; siehe [Sicherheitsmodell](../../security-model.md). |
| `WORKER_ENABLED` | `true` (`false` bei `APP_ROLE=admin`) | Hintergrundaufgaben; `false` auf zusätzlichen `all`-Instanzen. |
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
Nur `DATABASE_URL` setzt `compose.yaml` selbst. Unter Kubernetes kommen die
Variablen in das Secret `openstatuspage` oder in die `env:`-Liste von
`deployment.yaml`.

## Die Einstellungsseite

**Administration → Einstellungen** steuert die öffentliche Seite:

| Bereich | Einstellung | Wirkung |
| --- | --- | --- |
| Branding | Seitenname | Erscheint im Kopf der Seite, im Browser-Titel, in Feeds und im Betreff von E-Mails. |
| Branding | Beschreibung | Kurzer Text unter dem Seitennamen. |
| Branding | Logo-URL, Favicon-URL | `https://`-URLs oder Pfade. |
| Branding | Akzentfarbe | Farbe von Buttons und Hervorhebungen (Hex, z. B. `#7c6cf2`); wird für ausreichenden Kontrast automatisch angepasst, siehe [unten](#akzentfarbe-und-barrierefreiheit). |
| Anzeige | Standardsprache | Gilt, wenn die Browsersprache des Besuchers nicht verfügbar ist (Englisch oder Deutsch). |
| Anzeige | Standarddarstellung | System, hell oder dunkel; Besucher können umschalten. |
| Anzeige | Support-URL | Optionaler Link zu deiner Support- oder Kontaktseite. |
| Anzeige | Standorte anzeigen | Zeigt die Standortseite und die Karte. |
| Anzeige | Verfügbarkeit anzeigen | Zeigt Verfügbarkeitsbalken und Prozentwerte. |
| Anzeige | Tage der Verfügbarkeit | Tage in den Verfügbarkeitsbalken (7–180, Standard 90). |
| Anzeige | Tage für kürzliche Vorfälle | Wie lange behobene Vorfälle in der Übersicht bleiben (1–90, Standard 7). |
| Footer-Links | – | Bis zu 10 Links im Footer (z. B. Impressum, Datenschutzerklärung). |
| E-Mail-Abonnements | E-Mail-Abonnements anbieten | Bietet Abonnements auf der öffentlichen Seite an (setzt einen konfigurierten Mailserver voraus). Standard: aus. |
| E-Mail-Abonnements | Wartungserinnerung (Stunden) | Stunden vor einer geplanten Wartung, zu denen Abonnenten erinnert werden (0–168, 0 = aus, Standard 24). |

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
