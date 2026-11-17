# E-Mail-Abonnements

Besucher der öffentlichen Seite können E-Mail-Benachrichtigungen zu
öffentlichen Vorfällen und Wartungen abonnieren, entweder für alles oder für
ausgewählte Services. Abonnements sind aus, bis du einen Mailserver
konfigurierst und sie aktivierst.

## Überblick

1. Richte über Umgebungsvariablen einen [Mailserver](#mailserver) ein und
   starte die Anwendung neu.
2. Schick eine [Test-E-Mail](#test-e-mail).
3. Aktiviere **E-Mail-Abonnements** auf der Einstellungsseite und wähle die
   [Wartungserinnerung](#wartungserinnerungen).
4. Die öffentliche Seite bietet jetzt ein Formular zum Abonnieren an.

Das Formular erscheint nur, wenn Abonnements in den Einstellungen aktiviert
sind **und** eine Versandart (`smtp` oder `log`) konfiguriert ist.

## Mailserver

| Variable | Standard | Beschreibung |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp`, wenn `SMTP_HOST` gesetzt ist, sonst `none` | `smtp` versendet per SMTP. `log` schreibt jede E-Mail ins Server-Log, statt sie zu versenden (nur für Entwicklung und Tests). `none` schaltet E-Mail ab. |
| `SMTP_HOST` | – | Hostname des SMTP-Servers oder Relays. |
| `SMTP_PORT` | `587` | Port des SMTP-Servers. |
| `SMTP_SECURE` | `false` | `true` für implizites TLS (meist Port 465). Bei `false` wird die Verbindung per STARTTLS verschlüsselt, sofern der Server es anbietet. |
| `SMTP_USER` | – | Benutzername für die SMTP-Anmeldung (optional). |
| `SMTP_PASSWORD` | – | Passwort für die SMTP-Anmeldung. |
| `SMTP_FROM` | – | Absenderadresse, Pflicht für `smtp` und `log`, z. B. `Example Status <status@example.com>`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` akzeptiert ungültige TLS-Zertifikate des SMTP-Servers. Nur für interne Relays mit selbst signierten Zertifikaten; besser ist es, deine CA mit `NODE_EXTRA_CA_CERTS` hinzuzufügen. |

Beispiel für einen Mail-Anbieter mit Submission-Port und STARTTLS:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=status@example.com
SMTP_PASSWORD=<Passwort>
SMTP_FROM="Example Status <status@example.com>"
```

Beispiel für ein internes Relay ohne Anmeldung:

```bash
SMTP_HOST=mail-relay.example.com
SMTP_PORT=25
SMTP_FROM="Example Status <status@example.com>"
```

Bei Docker Compose trägst du die Variablen im Abschnitt `environment:` des
Dienstes `openstatuspage` ein und erstellst den Container neu
(`docker compose -f docker/docker-compose.yml up -d`).

## Test-E-Mail

Öffne als Administrator den E-Mail-Statusbereich auf der Einstellungsseite und
schick eine Test-E-Mail an deine eigene Adresse. Der Test wird sofort
versendet (nicht über die Warteschlange); schlägt er fehl, siehst du die
Fehlermeldung des Mailservers. Ohne konfigurierte Versandart wird der Test
abgelehnt.

## Abonnements aktivieren

Auf der Einstellungsseite (Administratoren):

- **E-Mail-Abonnements**: zeigt das Formular zum Abonnieren auf der
  öffentlichen Seite. Standard: aus.
- **Wartungserinnerung**: wie viele Stunden vor einer geplanten Wartung
  Abonnenten erinnert werden (0–168, Standard 24, 0 = keine Erinnerung).

Schaltest du Abonnements aus, verschwindet das Formular von der öffentlichen
Seite; bestehende Abonnenten bleiben erhalten.

Ergänze vor dem Aktivieren einen Link zur **Datenschutzerklärung** in den
Footer-Links der Einstellungen. Sie sollte erklären, wofür die Adressen
genutzt und wie lange sie gespeichert werden.

## So funktioniert das Abonnieren

1. Der Besucher gibt seine E-Mail-Adresse ein, wählt die Sprache (Deutsch oder
   Englisch) und entweder **alle Services** oder einzelne öffentliche Services
   (gruppiert wie auf der öffentlichen Seite).
2. OpenStatusPage schickt eine **Bestätigungs-E-Mail** (Double-Opt-in). Bis
   der Link darin angeklickt wird, ist das Abonnement inaktiv. Unbestätigte
   Abonnements werden nach **7 Tagen** automatisch gelöscht.
3. Nach der Bestätigung bekommt der Abonnent einen Link zur
   **Verwaltungsseite**, auf der er Services und Sprache ändern oder sich
   abmelden kann.

Details, die Abonnenten und deinen Mailserver schützen:

- Das Formular antwortet immer gleich, egal ob die Adresse neu, unbestätigt
  oder schon angemeldet ist. Niemand kann so herausfinden, wer abonniert hat.
- Erneutes Abonnieren mit einer unbestätigten Adresse verschickt die
  Bestätigung noch einmal; bei einer bestätigten Adresse bleiben die
  Einstellungen unverändert und es kommt stattdessen eine E-Mail mit dem Link
  zur Verwaltung. Solche E-Mails gehen höchstens alle 10 Minuten an dieselbe
  Adresse.
- Das Formular ist pro Client-IP begrenzt. Hinter einem Reverse Proxy braucht
  das ein korrektes `TRUST_PROXY` (siehe
  [Reverse Proxy](03-reverse-proxy.md#trust_proxy)).
- Links in E-Mails enthalten ein geheimes Token. Tokens werden nie im Klartext
  gespeichert; sie werden aus `SECRET_KEY` abgeleitet.
- Jede Benachrichtigung enthält einen Link zur Verwaltung, einen Link zum
  Abmelden und die `List-Unsubscribe`-Header für die Abmeldung mit einem Klick
  (RFC 8058), die viele Mailprogramme als „Abbestellen“-Button anzeigen.
- Beim Abmelden wird der Abonnent vollständig gelöscht.

## Wer bekommt was

E-Mails gibt es nur zu **öffentlichen** Vorfällen und Wartungen und nur, wenn
**Abonnenten benachrichtigen** angehakt war (siehe
[Tägliche Arbeit](06-daily-work.md#die-checkbox-abonnenten-benachrichtigen)):

| Ereignis | Wird verschickt, wenn |
| --- | --- |
| Neuer Vorfall, Vorfall-Update | die Checkbox in diesem Formular angehakt ist |
| Neue Wartung, Wartungs-Update | die Checkbox in diesem Formular angehakt ist |
| Wartungserinnerung | die Wartung Benachrichtigungen aktiviert hat und eine Erinnerungszeit eingestellt ist |
| Automatischer Start / Abschluss | die Wartung Benachrichtigungen aktiviert hat |

Empfänger sind die bestätigten Abonnenten mit **allen Services** sowie
diejenigen, die mindestens einen der betroffenen **öffentlichen** Services
gewählt haben. Ein Ereignis ohne betroffene öffentliche Services erreicht nur
die Abonnenten mit „alle Services“.

Jede E-Mail ist in der Sprache des Abonnenten verfasst und enthält den
Seitennamen im Betreff, Titel, Status, die Nachricht, die betroffenen
öffentlichen Services (nie versteckte), bei Wartungen den Zeitraum in UTC und
einen Link zur Seite des Vorfalls bzw. der Wartung.

## Wartungserinnerungen

Bei einer Erinnerungszeit von zum Beispiel 24 Stunden bekommen Abonnenten
24 Stunden vor dem geplanten Beginn jeder öffentlichen Wartung mit
aktivierten Benachrichtigungen eine Erinnerung. Jede Wartung wird höchstens
einmal erinnert.

## Versand und Warteschlange

E-Mails werden nicht während der Anfrage versendet. Sie landen in einer
Warteschlange (Outbox) in der Datenbank, die der Hintergrund-Worker abarbeitet:

- alle 10 Sekunden werden bis zu 50 E-Mails versendet;
- fehlgeschlagene Versuche werden nach 1 Minute, 5 Minuten, 15 Minuten und
  1 Stunde wiederholt; nach 5 Fehlversuchen gilt eine E-Mail als
  **fehlgeschlagen**;
- versendete und fehlgeschlagene Einträge werden nach 30 Tagen entfernt;
- E-Mails an einen Abonnenten, der sich inzwischen abgemeldet hat, entfallen.

Die Warteschlange verarbeitet nur eine Instanz mit `WORKER_ENABLED=true`.
Sorge dafür, dass genau eine solche Instanz läuft.

Probleme mit dem Mailserver lassen das Speichern eines Vorfalls oder einer
Wartung nie scheitern; sie tauchen stattdessen im Statusbereich auf.

## Zustellbarkeit

Benachrichtigungen nützen nur, wenn sie nicht im Spam landen. Für die Domain
von `SMTP_FROM` gilt:

- **SPF**: Der DNS-TXT-Eintrag der Domain muss deinen SMTP-Server oder
  Anbieter erlauben, z. B. `v=spf1 include:_spf.mail-provider.example -all`.
- **DKIM**: Lass den Mailserver oder Anbieter ausgehende E-Mails signieren und
  veröffentliche den öffentlichen Schlüssel im DNS. OpenStatusPage signiert
  selbst nicht.
- **DMARC**: Veröffentliche eine Richtlinie, z. B.
  `_dmarc.example.com TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"`,
  und achte darauf, dass SPF oder DKIM zur Absender-Domain passen.
- Nutze eine Absenderadresse auf einer Domain, die dir gehört, am besten eine
  Subdomain wie `status.example.com`, und keine Freemail-Adresse.
- Betreibst du einen eigenen Mailserver, braucht er einen passenden
  Reverse-DNS-Eintrag (PTR) und sollte auf keiner Blockliste stehen.

Die Header für die Abmeldung mit einem Klick, die große Mail-Anbieter von
Massenversendern verlangen, sind bereits enthalten.

## Abonnenten und Datenschutz

Administratoren sehen die Liste der Abonnenten (Adresse, Sprache, Services,
bestätigt oder unbestätigt) und können Abonnenten löschen. Das Löschen steht
mit maskierter Adresse im Audit-Log. Redakteure haben keinen Zugriff auf die
Adressen.

Gespeichert werden pro Abonnent: E-Mail-Adresse, Sprache, gewählte Services
sowie Zeitpunkt von Anmeldung und Bestätigung. Sonst nichts, keine
Tracking-Pixel, kein Link-Tracking.

## Fehlersuche

Der **E-Mail-Statusbereich** auf der Einstellungsseite zeigt:

- die Versandart (`smtp`, `log` oder `none`) und die Absenderadresse,
- die Zahl der bestätigten und unbestätigten Abonnenten,
- die Warteschlange: ausstehende und fehlgeschlagene E-Mails,
- wann zuletzt eine E-Mail versendet wurde und den letzten Fehler mit
  Zeitpunkt.

| Symptom | Prüfen |
| --- | --- |
| Kein Formular zum Abonnieren auf der öffentlichen Seite | Abonnements in den Einstellungen aktiviert? Versandart `smtp` oder `log`? |
| Versandart zeigt `none` | `SMTP_HOST` oder `MAIL_TRANSPORT` fehlt in der Umgebung des Containers; nach Änderungen neu starten. |
| Test-E-Mail schlägt fehl | Der Fehler im Statusbereich kommt vom Mailserver: falsche Kombination aus Port und `SMTP_SECURE`, falsche Zugangsdaten, Absender nicht erlaubt, TLS-Zertifikat nicht vertrauenswürdig. |
| Test klappt, Benachrichtigungen kommen nicht an | Wächst die Zahl der ausstehenden E-Mails? Dann läuft auf keiner Instanz der Worker (`WORKER_ENABLED`). War **Abonnenten benachrichtigen** angehakt und der Vorfall öffentlich? Ist der Abonnent bestätigt und hat er einen betroffenen Service gewählt? |
| Fehlgeschlagene E-Mails in der Warteschlange | Ursache aus dem letzten Fehler beheben, dann mit **Fehlgeschlagene erneut senden** wieder einreihen. |
| E-Mails landen im Spam | Siehe [Zustellbarkeit](#zustellbarkeit). |
| Links in E-Mails funktionieren nicht | `BASE_URL` falsch, oder `SECRET_KEY` wurde seit dem Versand geändert. |

Für die Entwicklung setzt du `MAIL_TRANSPORT=log` und `SMTP_FROM`: E-Mails
erscheinen dann im Server-Log, statt versendet zu werden.
