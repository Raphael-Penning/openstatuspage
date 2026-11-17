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
| `WORKER_ENABLED` | `true` | Hintergrundaufgaben; `false` auf zusätzlichen Instanzen. |
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

Bei Docker Compose gilt: Nur Variablen, die im Abschnitt `environment:` des
Dienstes `openstatuspage` stehen, kommen im Container an. Die E-Mail-Variablen
(`MAIL_TRANSPORT`, `SMTP_*`) stehen dort bereits; du setzt sie also wie
`SECRET_KEY` in deiner Env-Datei oder in der Shell.

## Die Einstellungsseite

**Administration → Einstellungen** steuert die öffentliche Seite:

| Bereich | Einstellung | Wirkung |
| --- | --- | --- |
| Branding | Seitenname | Erscheint im Kopf der Seite, im Browser-Titel, in Feeds und im Betreff von E-Mails. |
| Branding | Beschreibung | Kurzer Text unter dem Seitennamen. |
| Branding | Logo-URL, Favicon-URL | `https://`-URLs oder Pfade. |
| Branding | Akzentfarbe | Farbe von Buttons und Hervorhebungen (Hex, z. B. `#7c6cf2`). |
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
- `docker compose -f docker/docker-compose.yml exec openstatuspage env` zeigt,
  was tatsächlich im Container ankommt (enthält Geheimnisse, also nirgends
  einfügen).
