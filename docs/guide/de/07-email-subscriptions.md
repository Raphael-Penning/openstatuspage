# E-Mail-Abonnements

Besucher der öffentlichen Seite können E-Mail-Benachrichtigungen zu
öffentlichen Vorfällen und Wartungen abonnieren, entweder für alle Updates
oder für ausgewählte Services. Abonnements sind aus, bis du einen Mailserver
konfigurierst und sie aktivierst.

## Überblick

1. Richte über Umgebungsvariablen einen [Mailserver](#mailserver) ein und
   starte die Anwendung neu.
2. Schick eine [Test-E-Mail](#test-e-mail).
3. Schalte auf der Einstellungsseite im Bereich **E-Mail-Abonnements** die
   Option **E-Mail-Abonnements anbieten** ein, wähle die
   [Wartungserinnerung](#wartungserinnerungen) und speichere.
4. Im Menü **Updates abonnieren** der öffentlichen Seite gibt es jetzt den
   Eintrag **E-Mail-Benachrichtigungen**, der zum Anmeldeformular
   (`/subscribe`) führt.

Der Eintrag erscheint nur, wenn Abonnements in den Einstellungen aktiviert
sind **und** eine Versandart (`smtp` oder `log`) konfiguriert ist. Aktivierst
du Abonnements ohne Versandart, zeigt die Einstellungsseite eine Warnung.

## Mailserver

| Variable | Standard | Beschreibung |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp`, wenn `SMTP_HOST` gesetzt ist, sonst `none` | `smtp` versendet per SMTP. `log` schreibt jede E-Mail ins Server-Log, statt sie zu versenden (nur für Entwicklung und Tests: Das Log enthält dann die Links aus Bestätigungs- und Verwaltungs-E-Mails). `none` schaltet E-Mail ab, auch wenn `SMTP_HOST` gesetzt ist. |
| `SMTP_HOST` | – | Hostname des SMTP-Servers oder Relays. Pflicht für `smtp`. |
| `SMTP_PORT` | `587` | Port des SMTP-Servers. |
| `SMTP_SECURE` | `false` | `true` für implizites TLS (meist Port 465). Bei `false` wird die Verbindung per STARTTLS verschlüsselt, sofern der Server es anbietet. |
| `SMTP_USER` | – | Benutzername für die SMTP-Anmeldung. Bei Relays ohne Anmeldung leer lassen. |
| `SMTP_PASSWORD` | – | Passwort für die SMTP-Anmeldung. |
| `SMTP_FROM` | – | Absenderadresse, Pflicht für `smtp` und `log`, z. B. `Example Status <status@example.com>`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` akzeptiert ungültige TLS-Zertifikate des SMTP-Servers. Nur für interne Relays mit selbst signierten Zertifikaten; besser ist es, deine CA mit `NODE_EXTRA_CA_CERTS` hinzuzufügen. |

Der Server startet nicht, wenn `SMTP_FROM` fehlt oder keine E-Mail-Adresse
ist (bei `smtp` oder `log`) oder wenn `MAIL_TRANSPORT=smtp` ohne `SMTP_HOST`
gesetzt ist. Die Fehlermeldung beim Start nennt die Variable.

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

Mit Docker Compose trägst du die Variablen in `.env` neben `compose.yaml`
ein (die Vorlage hat dafür einen Mail-Abschnitt, siehe
[Installation](02-installation.md#einstellungen-in-env)); `compose.yaml`
musst du nicht anpassen. Erstelle den Container danach mit
`docker compose up -d` neu. Setz `SMTP_FROM` in Anführungszeichen, wenn es
Leerzeichen oder spitze Klammern enthält, und ein `SMTP_PASSWORD` mit `$` in
einfache Anführungszeichen.
Unter Kubernetes ergänzt du die Variablen im Secret `openstatuspage` und
startest den Pod mit
`kubectl -n openstatuspage rollout restart deployment/openstatuspage` neu.

## Test-E-Mail

Öffne als Administrator die Einstellungsseite. Im Bereich
**E-Mail-Abonnements** findest du den Kasten **E-Mail-Versand** mit dem Feld
**Test-E-Mail senden an**: Gib deine eigene Adresse ein und klick auf
**Test-E-Mail senden**. Der Test wird sofort versendet (nicht über die
Warteschlange), und zwar in der Standardsprache der Seite. Das Ergebnis
erscheint unter den Buttons; schlägt der Versand fehl, siehst du dort die
Fehlermeldung des Mailservers. Ohne konfigurierte Versandart ist der Button
deaktiviert. Mit `MAIL_TRANSPORT=log` landet die Test-E-Mail im Server-Log.

## Abonnements aktivieren

Auf der Einstellungsseite (Administratoren), Bereich **E-Mail-Abonnements**:

- **E-Mail-Abonnements anbieten**: bietet Abonnements auf der öffentlichen
  Seite an. Standard: aus.
- **Wartungserinnerung (Stunden)**: wie viele Stunden vor einer geplanten
  Wartung Abonnenten erinnert werden (0–168, Standard 24, 0 = keine
  Erinnerung).

Schaltest du **E-Mail-Abonnements anbieten** aus, verschwindet der Eintrag von
der öffentlichen Seite, und die Anmeldeseite meldet, dass
E-Mail-Benachrichtigungen nicht verfügbar sind. Solange die Option aus ist,
werden **gar keine Benachrichtigungen** verschickt (weder zu Vorfällen und
Wartungen noch Erinnerungen oder automatischer Start und Abschluss); E-Mails,
die schon in der Warteschlange stehen, werden noch zugestellt. Bestehende
Abonnenten bleiben erhalten, und die Links in ihren E-Mails funktionieren
weiter, sodass sie ihre Einstellungen ändern oder sich abmelden können.

Ergänze vor dem Aktivieren einen Link zur **Datenschutzerklärung** in den
**Footer-Links** der Einstellungen. Sie sollte erklären, wofür die Adressen
genutzt und wie lange sie gespeichert werden.

## So funktioniert das Abonnieren

1. Der Besucher öffnet **Updates abonnieren → E-Mail-Benachrichtigungen**,
   gibt seine E-Mail-Adresse ein, wählt die **Sprache der E-Mails** (Deutsch
   oder Englisch) und entweder **Alle Updates** oder **Ausgewählte Dienste**
   (nur öffentliche Services, gruppiert wie auf der öffentlichen Seite).
2. OpenStatusPage schickt eine **Bestätigungs-E-Mail** (Double-Opt-in). Bis
   der Link darin angeklickt wird, ist das Abonnement inaktiv. Unbestätigte
   Anmeldungen werden nach **7 Tagen** automatisch gelöscht (gerechnet ab der
   letzten Bestätigungs-E-Mail).
3. Nach der Bestätigung bietet die Seite **Einstellungen verwalten** an.
   Jede Benachrichtigung enthält außerdem einen Link zu dieser
   Verwaltungsseite, auf der der Abonnent Services und Sprache ändern oder
   sich abmelden kann.

Details, die Abonnenten und deinen Mailserver schützen:

- Das Formular antwortet immer gleich und gleich schnell, egal ob die Adresse
  neu, unbestätigt oder schon angemeldet ist. Niemand kann so herausfinden,
  wer abonniert hat.
- Erneutes Abonnieren ändert nie die Auswahl einer vorhandenen Adresse. Eine
  unbestätigte Adresse bekommt die Bestätigung noch einmal (die Auswahl lässt
  sich nach der Bestätigung auf der Verwaltungsseite ändern); eine bestätigte
  Adresse bekommt stattdessen eine E-Mail mit dem Link zur Verwaltung. Solche
  E-Mails gehen höchstens alle 10 Minuten an dieselbe Adresse.
- Das Abonnieren ist auf 5 Anfragen pro Minute und Client-IP begrenzt (das
  Formular mit und ohne JavaScript zusammen), die
  Links zum Bestätigen, Verwalten und Abmelden auf 30 pro Minute. Hinter einem
  Reverse Proxy braucht das ein korrektes `TRUST_PROXY` (siehe
  [Reverse Proxy](03-reverse-proxy.md#trust_proxy)).
- Links in E-Mails enthalten ein geheimes Token. Tokens werden nie
  gespeichert, auch nicht in der Warteschlange; sie werden beim Versand aus
  `SECRET_KEY` und einem Zufallswert pro Abonnent abgeleitet. Das Token steht
  im Query-String des Links, damit die Seiten auch ohne JavaScript
  funktionieren. Das Server-Log blendet es aus; wenn dein Reverse Proxy
  vollständige URLs protokolliert, halte dieses Log privat oder lass den
  Query-String darin weg.
- Zum Bestätigen braucht es einen Klick auf **Abonnement bestätigen**. Das
  bloße Öffnen des Links (etwa durch den Link-Scanner eines Mail-Anbieters)
  bestätigt nichts.
- Der Bestätigungslink führt nur einmal zur Verwaltungsseite. Nutzt du ihn
  nach der Bestätigung noch einmal, zeigt er „Dieses Abonnement ist bereits
  bestätigt“ und erklärt, wie du es verwaltest: über den Link in einer
  beliebigen Benachrichtigung oder indem du mit derselben Adresse erneut
  abonnierst, dann kommt ein Verwaltungslink per E-Mail. Eine alte
  Bestätigungs-E-Mail bleibt so kein Schlüssel zum Abonnement.
- Anmelden, Bestätigen, Einstellungen ändern und Abmelden funktionieren auch
  ohne JavaScript als normale Formulare.
- Jede Benachrichtigung enthält einen Link zur Verwaltung und einen Link zum
  Abmelden. Der Abmeldelink öffnet die Verwaltungsseite mit bereits
  angezeigter Rückfrage, ein Klick auf **Ja, abmelden** genügt dann.
- Benachrichtigungen tragen außerdem die Header `List-Unsubscribe` und
  `List-Unsubscribe-Post` für die Abmeldung mit einem Klick (RFC 8058). Viele
  Mailprogramme zeigen sie als „Abbestellen“-Button an, der direkt abmeldet,
  ohne die Seite zu öffnen. Ruft man diese Adresse im Browser auf, landet man
  nur auf der Verwaltungsseite; abgemeldet wird dabei nicht.
- Beim Abmelden wird der Abonnent vollständig gelöscht, einschließlich
  E-Mails, die noch in der Warteschlange stehen.

## Wer bekommt was

E-Mails gibt es nur zu **öffentlichen** Vorfällen und Wartungen, nur solange
E-Mail-Abonnements aktiviert sind und nur, wenn **Abonnenten benachrichtigen**
angehakt war (siehe
[Tägliche Arbeit](06-daily-work.md#die-checkbox-abonnenten-benachrichtigen)):

| Ereignis | Wird verschickt, wenn |
| --- | --- |
| Neuer Vorfall | die Checkbox in **Neuer Vorfall** angehakt ist |
| Vorfall-Update | die Checkbox in **Update veröffentlichen** oder **Beheben** angehakt ist |
| Neue Wartung (Ankündigung) | die Checkbox in **Wartung planen** angehakt ist |
| Wartungs-Update | die Checkbox in **Update veröffentlichen**, **Jetzt starten**, **Abschließen** oder **Wartung absagen** angehakt ist |
| Wartungserinnerung | die Wartung Benachrichtigungen aktiviert hat und die Erinnerung nicht 0 ist, siehe [Wartungserinnerungen](#wartungserinnerungen) |
| Automatischer Start / Abschluss | die Wartung Benachrichtigungen aktiviert hat |

„Benachrichtigungen aktiviert“ ist die Wahl, die beim Planen mit der Wartung
gespeichert wurde; ändern kannst du sie unter **Wartung bearbeiten**. Das
Bearbeiten eines Vorfalls, einer Wartung oder eines bestehenden Updates
verschickt nie eine E-Mail.

Empfänger sind die bestätigten Abonnenten mit **Alle Updates** sowie
diejenigen, die mindestens einen der betroffenen **öffentlichen** Services
gewählt haben. Ein Ereignis ohne betroffene öffentliche Services erreicht nur
die Abonnenten mit „Alle Updates“.

Jede E-Mail ist in der Sprache des Abonnenten verfasst und enthält den
Seitennamen im Betreff, Titel, Status, die Nachricht, die betroffenen
öffentlichen Services (nie versteckte), bei Vorfällen die Auswirkung, bei
Wartungen den Zeitraum in UTC und einen Link zur Seite des Vorfalls bzw. der
Wartung. E-Mails zum automatischen Start und Abschluss enthalten einen
Standardsatz wie „Die Wartung hat begonnen.“

## Wartungserinnerungen

Bei einer Erinnerungszeit von zum Beispiel 24 Stunden bekommen Abonnenten
24 Stunden vor dem geplanten Beginn jeder öffentlichen Wartung mit
aktivierten Benachrichtigungen eine Erinnerung. Der Worker prüft das einmal
pro Minute.

- Jede Wartung wird höchstens einmal erinnert. Ihre Detailseite zeigt, wann
  die Erinnerung eingereiht wurde.
- Eine Wartung, die weniger als 24 Stunden vor ihrem Beginn geplant wird,
  bekommt keine Erinnerung: Die Ankündigung ist ja gerade erst verschickt
  worden.
- Verschiebst du den Beginn nach hinten, werden Abonnenten vor dem neuen
  Beginn noch einmal erinnert.
- Erinnert werden nur Wartungen, die noch *Geplant* sind.
- Mit dem Wert 0 schaltest du Erinnerungen für alle Wartungen ab.

## Versand und Warteschlange

E-Mails werden nicht während der Anfrage versendet. Sie landen in einer
Warteschlange (Outbox) in der Datenbank, die der Hintergrund-Worker abarbeitet:

- neue E-Mails werden sofort versendet; zusätzlich prüft der Worker die
  Warteschlange alle 10 Sekunden und verschickt fällige E-Mails in Blöcken
  von 50;
- fehlgeschlagene Versuche werden nach 1 Minute, 5 Minuten, 15 Minuten und
  1 Stunde wiederholt; nach 5 Fehlversuchen gilt eine E-Mail als
  **fehlgeschlagen**;
- versendete und fehlgeschlagene Einträge werden nach 30 Tagen entfernt;
- E-Mails an einen Abonnenten, der sich inzwischen abgemeldet hat oder
  gelöscht wurde, entfallen.

Die Warteschlange verarbeitet nur eine Instanz mit `WORKER_ENABLED=true`.
Sorge dafür, dass genau eine solche Instanz läuft; ohne sie bleiben die
E-Mails in der Warteschlange liegen.

Probleme mit dem Mailserver lassen das Speichern eines Vorfalls oder einer
Wartung nie scheitern; sie tauchen stattdessen im Kasten **E-Mail-Versand**
auf.

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
- Setz `BASE_URL` auf die echte öffentliche URL: Alle Links in den E-Mails
  verwenden sie.

Die Header für die Abmeldung mit einem Klick, die große Mail-Anbieter von
Massenversendern verlangen, sind bereits enthalten.

## Abonnenten und Datenschutz

**Administration → Abonnenten** (nur Administratoren) listet alle Abonnenten
mit Adresse, Status (*Bestätigt* oder *Unbestätigt*), Abo-Umfang
(**Alle Updates** oder die gewählten Services), Sprache sowie dem Datum von
Anmeldung und Bestätigung. Du kannst nach Adressen suchen, nach Status
filtern und Abonnenten löschen. Das Löschen lässt sich nicht rückgängig
machen; die Adresse bekommt keine E-Mails mehr, und eingereihte E-Mails
werden verworfen. Das Löschen eines Abonnenten, Test-E-Mails und
**Fehlgeschlagene erneut senden** stehen im Audit-Log; Adressen erscheinen
dort nur maskiert (`j***@example.com`). Redakteure haben keinen Zugriff auf
die Adressen.

Gespeichert werden pro Abonnent: E-Mail-Adresse, Sprache, **Alle Updates**
oder die gewählten Services, die Zeitpunkte von Anmeldung, Bestätigung und
letzter Bestätigungs-E-Mail sowie ein Zufallswert, aus dem die Tokens der
Links abgeleitet werden. Die Warteschlange hebt die E-Mails selbst
(Empfänger, Betreff, Text) höchstens 30 Tage auf. Sonst nichts: keine
Tracking-Pixel, kein Link-Tracking.

## Fehlersuche

Der Kasten **E-Mail-Versand** auf der Einstellungsseite zeigt:

- **Versand** (*SMTP*, *Server-Log* oder *Nicht konfiguriert*) und
  **Absender**,
- **Abonnenten**: die Zahl der bestätigten und unbestätigten Abonnenten,
- **Warteschlange**: ausstehende und fehlgeschlagene E-Mails,
- **Zuletzt gesendet** und **Letzter Fehler** mit Zeitpunkt.

| Symptom | Prüfen |
| --- | --- |
| Kein Eintrag **E-Mail-Benachrichtigungen** auf der öffentlichen Seite | **E-Mail-Abonnements anbieten** eingeschaltet und gespeichert? Versand nicht *Nicht konfiguriert*? |
| Versand zeigt *Nicht konfiguriert* | `SMTP_HOST` oder `MAIL_TRANSPORT` kommt nicht beim Server an (bei Compose: Steht die Variable in der übergebenen Env-Datei oder ist sie exportiert?); nach Änderungen neu starten. |
| Test-E-Mail schlägt fehl | Der Fehler unter dem Button kommt vom Mailserver: falsche Kombination aus Port und `SMTP_SECURE`, falsche Zugangsdaten, Absender nicht erlaubt, TLS-Zertifikat nicht vertrauenswürdig. |
| Test klappt, Benachrichtigungen kommen nicht an | Wächst die Zahl der ausstehenden E-Mails? Dann läuft auf keiner Instanz der Worker (`WORKER_ENABLED`). War **Abonnenten benachrichtigen** angehakt, der Vorfall bzw. die Wartung öffentlich und **E-Mail-Abonnements anbieten** eingeschaltet? Ist der Abonnent bestätigt und hat er **Alle Updates** oder einen betroffenen öffentlichen Service gewählt? |
| Keine Wartungserinnerung | Sind für die Wartung Benachrichtigungen aktiviert (Detailseite)? Steht die Erinnerung auf 0? Wurde die Wartung kürzer als die Erinnerungszeit vor ihrem Beginn geplant? |
| Fehlgeschlagene E-Mails in der Warteschlange | Ursache aus **Letzter Fehler** beheben, dann mit **Fehlgeschlagene erneut senden** wieder einreihen. |
| E-Mails landen im Spam | Siehe [Zustellbarkeit](#zustellbarkeit). |
| Links in E-Mails funktionieren nicht | `BASE_URL` falsch, `SECRET_KEY` seit dem Versand geändert, oder die unbestätigte Anmeldung wurde nach 7 Tagen schon gelöscht. |

Für die Entwicklung setzt du `MAIL_TRANSPORT=log` und `SMTP_FROM`: E-Mails
erscheinen dann im Server-Log, statt versendet zu werden.
