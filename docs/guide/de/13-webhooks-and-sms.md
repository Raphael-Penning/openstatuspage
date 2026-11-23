# Webhooks und SMS

Neben E-Mail kann OpenStatusPage Vorfälle und Wartungen in Chat-Kanäle und an
eigene Endpunkte senden (Webhooks) und als Kurznachricht verschicken (SMS): an
dein Team und, wenn du es erlaubst, an Besucher, die sich auf der öffentlichen
Seite anmelden. Alles stellst du in der Verwaltung unter **Administration →
Webhooks & SMS** ein. Dafür ist keine zusätzliche Umgebungsvariable nötig; die
Geheimnisse sind verschlüsselt (siehe [Konfiguration](../../configuration.md#webhooks-and-sms)).

Webhooks und SMS erhalten dieselben Ereignisse wie die E-Mail-Abonnenten: ein
neuer oder aktualisierter öffentlicher Vorfall oder eine Wartung, wenn
**Abonnenten benachrichtigen** aktiv bleibt, den automatischen Beginn und das
Ende eines Wartungsfensters und die Wartungserinnerung. Private Vorfälle und
versteckte Dienste werden nie gesendet.

## Team-Webhooks

1. Öffne **Webhooks & SMS** und wähle **Webhook hinzufügen**.
2. Wähle den Typ und füge die URL ein:
   - **Discord**: Servereinstellungen > Integrationen > Webhooks > Neuer Webhook
     > Webhook-URL kopieren.
   - **Slack**: eine App mit *Incoming Webhooks*; kopiere die Webhook-URL des
     Kanals.
   - **Microsoft Teams**: im Kanal **Workflows** > *In einem Kanal posten, wenn
     eine Webhook-Anforderung empfangen wird*; kopiere die angezeigte URL. Die
     Nachricht ist eine Adaptive Card. Die eingestellten Office-365-Connectors
     werden nicht unterstützt.
   - **Generisches JSON**: jeder eigene https-Endpunkt. Die Antwort auf das
     Anlegen zeigt das **Signaturgeheimnis einmal**; kopiere es in das
     empfangende System (siehe [Generische Webhooks prüfen](#generische-webhooks-prüfen)).
     Du kannst zusätzliche Header angeben (zum Beispiel `Authorization`); ihre
     Werte werden verschlüsselt gespeichert.
3. Wähle **Alle Dienste** oder die Dienste, für die der Webhook gilt.
4. Speichere und sende über die Testschaltfläche in der Zeile des Webhooks eine
   Testnachricht.

Die URL kann nur geschrieben werden: Die Liste zeigt nur den Host, denn der Pfad
von Discord-, Slack- und Teams-URLs ist das Geheimnis. Um sie zu ändern, gib die
ganze URL neu ein.

Die Schaltfläche **Zustellprotokoll** in der Zeile öffnet das Protokoll der
Zustellungen (Zeit, Ereignis, Status, HTTP-Status oder Fehler, nie die URL oder
die Nachricht). Fehlgeschlagene Zustellungen werden
nach 1, 5, 15 und 60 Minuten wiederholt; eine `4xx`-Antwort (außer 408, 425 und
429) wird nicht wiederholt. Nach **10 fehlgeschlagenen Zustellungen in Folge**
wird ein Webhook deaktiviert, der Grund steht in der Liste und alle Admins
erhalten eine E-Mail (wenn ein Mailserver eingerichtet ist). Aktiviere ihn
wieder, sobald der Endpunkt funktioniert.

`http://`-URLs werden abgelehnt, außer du setzt für einen Webhook **http://
erlauben**. Unabhängig davon verbindet sich der Server nie mit privaten,
Loopback- oder Link-Local-Adressen, folgt keinen Weiterleitungen und bricht
nach 10 Sekunden ab.

## SMS

### Anbieter

SMS werden mit einer HTTP-Anfrage versendet, die aus einer Vorlage entsteht.
Wähle eine **Vorlage** (Twilio, Vonage, seven.io, MessageBird) und gib Absender
und Zugangsdaten ein:

| Vorlage | Zugangsdatum 1 | Zugangsdatum 2 | Absender |
| --- | --- | --- | --- |
| Twilio | Account SID | Auth Token | Eine Twilio-Nummer im internationalen Format |
| Vonage (Messages API) | API-Key | API Secret | Eine Nummer oder ein alphanumerischer Absender deines Kontos |
| seven.io | – | API-Key | Nummer oder Name |
| MessageBird | – | Access Key | Nummer oder Name |

Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt; lass das
Feld leer, um sie zu behalten. Mit **Eigene** beschreibst du die Anfrage selbst:
Methode, URL, Header, ein Formular- oder JSON-Body und die Statuscodes, die
Erfolg bedeuten. Die Platzhalter `{{to}}`, `{{to_digits}}` (ohne `+`),
`{{from}}`, `{{text}}`, `{{username}}`, `{{password}}` und `{{basic_auth}}`
werden für jede SMS gefüllt. Die [Referenz zu Benachrichtigungen](../../notifications.md#sms)
nennt, was jede Vorlage über die API des Anbieters annimmt.

Sende eine Test-SMS, bevor du dich darauf verlässt. Jede SMS ist ein einzelnes
Segment: Texte werden auf 160 GSM-7-Zeichen gekürzt (70 bei Zeichen außerhalb
von GSM-7).

### Bereitschaftsnummern

Unter **Bereitschafts-SMS-Empfänger** trägst du die Nummern deines Teams im
internationalen Format ein (`+49 151 2345678`), für alle oder ausgewählte
Dienste. Sie erhalten jedes Ereignis ihrer Dienste, auch wenn das
Monatsbudget verbraucht ist.

## Abonnements von Besuchern

Unter **Abonnements von Besuchern und Limits**:

- **Discord-, Slack- und Teams-Webhooks**: Besucher dürfen mit den offiziellen
  Webhook-URLs dieser Dienste abonnieren.
- **Generische Webhooks**: standardmäßig aus. Schalte sie nur ein, wenn jeder
  https-Endpunkt im Internet deine Benachrichtigungen erhalten darf.
- **Länder für SMS-Abonnements**: die Ländervorwahlen (`49, 43, 41`), deren
  Nummern abonnieren dürfen. Leer (Standard) heißt: keine SMS-Abonnements.
- **SMS pro Monat**: Ist das Budget erreicht, pausieren SMS an Besucher und neue
  SMS-Abonnements bis zum nächsten Monat, und die Admins erhalten eine E-Mail.
- Die Limits pro Minute und Stunde.

Die Anmeldeseite (`/subscribe`) verlinkt dann auf **Webhook** und **SMS**. Ein
Besucher gibt URL oder Nummer ein und erhält eine Nachricht mit einem
**6-stelligen Code**; das Abonnement startet, sobald der Code auf der Seite
eingegeben ist (gültig 24 Stunden, 5 Versuche). Jede Nachricht enthält einen
kurzen Link zum Verwalten oder Beenden. Alles funktioniert ohne JavaScript.

Abonnenten aller Kanäle findest du unter **Abonnenten** (Kanal oben umschalten).
Unbestätigte Abonnements werden nach 7 Tagen gelöscht, und ein Abonnent, dessen
Ziel die letzten fünf Nachrichten abgelehnt hat (ein gelöschter Webhook, eine
Nummer, die dein Anbieter ablehnt), wird automatisch entfernt. Probleme auf
deiner Seite, etwa ein verbrauchtes Budget, falsche Zugangsdaten des Anbieters
oder ein Netzwerkausfall, entfernen nie Abonnenten.

### STOP-Antworten

OpenStatusPage empfängt keine SMS. Antworten wie `STOP` verarbeitet dein
Anbieter: Twilio etwa sperrt weitere Nachrichten an eine Nummer, die mit `STOP`
geantwortet hat. Diese Sendungen schlagen dann fehl, und nach fünf
abgelehnten Nachrichten wird das Abonnement entfernt. Jede SMS enthält
außerdem den Abmeldelink.

## Generische Webhooks prüfen

Generische Webhooks senden JSON (`"version": 1`, siehe die
[Referenz zu Benachrichtigungen](../../notifications.md#generic-json-payload))
mit diesen Headern:

- `X-OSP-Timestamp`: Unix-Zeit in Sekunden.
- `X-OSP-Signature`: `v1=` und der hexadezimale HMAC-SHA256 von
  `<timestamp>.<body>` mit dem Signaturgeheimnis.

Berechne den HMAC über den unveränderten Body, vergleiche in konstanter Zeit und
lehne Zeitstempel ab, die älter als fünf Minuten sind. Besucher mit einem
generischen Webhook finden ihren Schlüssel auf ihrer Verwaltungsseite.
