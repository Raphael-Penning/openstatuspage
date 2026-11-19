# Monitoring anbinden

OpenStatusPage überwacht selbst nichts. Es übernimmt Check-Ergebnisse aus den
Monitoring-Systemen, die du schon betreibst, und du baust daraus öffentliche
Services. Diese Seite gibt einen Überblick; die ausführliche Dokumentation der
Adapter (Englisch) liegt in [`docs/adapters/`](../../adapters/README.md).

| System | Pull (Statusseite fragt ab) | Push (Monitoring sendet) | Details |
| --- | --- | --- | --- |
| Icinga 2 | REST-API | Benachrichtigungsskript aus `contrib/icinga2` | [icinga2.md](../../adapters/icinga2.md) |
| Uptime Kuma | Prometheus-Endpunkt `/metrics` | eingebaute Webhook-Benachrichtigung | [uptime-kuma.md](../../adapters/uptime-kuma.md) |
| openITCockpit | JSON-API | Benachrichtigungsbefehl aus `contrib/openitcockpit` | [openitcockpit.md](../../adapters/openitcockpit.md) |
| alles andere | – | generischer JSON-Webhook | [Generic push API](../../adapters/README.md#generic-push-api) |

## Pull oder Push?

**Pull**: Die Statusseite fragt die Monitoring-API in festen Abständen ab
(standardmäßig alle 60 Sekunden pro Quelle) und übernimmt immer den
vollständigen Satz an Checks. Neue Checks erscheinen automatisch, entfernte
verschwinden samt ihren Verknüpfungen zu Services. Schlägt eine Abfrage fehl,
wird nur ein Fehler an der Quelle vermerkt; die Checks behalten ihren letzten
Zustand. Eine gestörte Verbindung verändert die öffentliche Seite also nie von
sich aus.

**Push**: Das Monitoring-System ruft OpenStatusPage bei jeder
Zustandsänderung auf. Änderungen sind in Sekunden sichtbar, aktualisiert
werden nur die gemeldeten Checks, und die Statusseite braucht keine
Zugangsdaten zu deinem Monitoring.

Beides lässt sich an einer Quelle kombinieren: Pull für die vollständige
Liste, Push für schnelle Updates.

Welche Richtung passt, hängt von deinem Netz ab:

| | Push | Pull |
| --- | --- | --- |
| Verbindung | Monitoring → Statusseite (ausgehendes HTTPS) | Statusseite → Monitoring-API (eingehend in dein Netz) |
| Zugangsdaten auf der Statusseite | keine (nur ein gehashtes Ingest-Token) | API-Zugangsdaten, verschlüsselt gespeichert |
| Typischer Einsatz | Statusseite in einer DMZ oder in der Cloud | Statusseite im selben vertrauenswürdigen Netz |

Ist die Statusseite aus dem Internet erreichbar, **empfehlen wir Push**: Eine
kompromittierte Statusseite kommt dann nicht an dein Monitoring heran.

Lege für Pull einen eigenen **Nur-Lese-Benutzer** an, der auf die Objekte
beschränkt ist, die die Statusseite speisen. Lass die TLS-Prüfung an; für
eine interne CA setzt du `NODE_EXTRA_CA_CERTS=/pfad/zur/ca.pem` in der
Umgebung, statt die Prüfung abzuschalten.

## Eine Quelle anbinden

1. **Monitoring → Quellen → Neue Quelle** (Administratoren): Typ wählen.
   - Für Pull trägst du Basis-URL und Zugangsdaten ein und prüfst mit
     **Verbindung testen**. **Jetzt abfragen** importiert sofort.
   - Für Push kopierst du **Ingest-URL** und **Ingest-Token**. Das Token wird
     nur einmal angezeigt; du kannst es später erneuern.
2. Richte die Monitoring-Seite ein, wie in der Adapter-Dokumentation
   beschrieben (Icinga-2-Benachrichtigungsbefehl, Webhook-Benachrichtigung in
   Uptime Kuma, openITCockpit-Benachrichtigungsbefehl oder ein eigenes Skript).
3. Importierte Checks erscheinen unter **Monitoring → Checks**.

Die Quellenliste zeigt Zeitpunkt und Ergebnis der letzten Abfrage. Eine
Quelle mit fehlschlagender Abfrage behält ihre Checks im letzten Zustand;
behebe den dort angezeigten Fehler.

### Generischer Webhook

Für Skripte, Cronjobs oder Systeme ohne eigenen Adapter legst du eine Quelle
vom Typ **Webhook (Push)** an und sendest JSON:

```bash
curl -fsS https://status.example.com/api/ingest/<source-id> \
  -H "Authorization: Bearer $OSP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"checks":[{"id":"backup-nightly","name":"Nächtliches Backup","state":"ok"}]}'
```

Zustände sind `ok`, `warning`, `critical`, `unknown` oder `0`–`3`. Nutze
lieber den `Authorization`-Header als den Query-Parameter `?token=`:
Query-Strings landen gern in Proxy-Logs. Das vollständige Format beschreibt
[`docs/adapters/README.md`](../../adapters/README.md#generic-push-api).

Mit `"full": true` sagst du, dass die Nutzdaten die vollständige Liste der
Checks sind: Fehlende Checks werden entfernt, samt ihrer Verknüpfungen zu
Services. Das geht nur bei Quellen vom Typ **Webhook (Push)**; andere Typen
bekommen ihre Liste per Abfrage, dort antwortet der Server mit `400`. Als
Schutz wird ein vollständiger Push, der mehr als die Hälfte der mit Services
verknüpften oder in Check-Bündeln verwendeten Checks entfernen würde, mit `409`
abgelehnt und ändert nichts. Ist das Entfernen gewollt, lös die Verknüpfungen
vorher (bzw. nimm die Checks aus dem Bündel).

## Services aus Checks zusammensetzen

Ein öffentlicher Service besteht aus beliebig vielen internen Checks:

1. **Katalog → Services & Sites**: Service anlegen (oder einen bestehenden
   öffnen) mit der Statusquelle **Automatisch**.
2. Unter **Verknüpfte Monitoring-Checks** mit **Checks verknüpfen** nach
   Name, Host oder ID suchen.
3. Für jede Verknüpfung festlegen, welchen Service-Status ein Check-Zustand
   auslöst:

   | Check-Zustand | Standard-Service-Status |
   | --- | --- |
   | OK | – (keine Wirkung) |
   | Warnung | Eingeschränkte Leistung |
   | Kritisch | Schwerer Ausfall |
   | Unbekannt | ignoriert |

   Jede Zuordnung kannst du pro Verknüpfung ändern oder auf „Ignorieren“
   setzen. Ein Check für eine unwichtige Komponente kann *Kritisch* zum
   Beispiel nur auf *Eingeschränkte Leistung* abbilden.
4. Wählen, wie die Checks zusammengefasst werden:
   - **Schlechtester Check**: Der schlechteste zugeordnete Status gilt. Passt,
     wenn jede Komponente gebraucht wird.
   - **Redundanz (Quorum)**: Für redundante Komponenten (z. B. mehrere
     Webserver hinter einem Load Balancer). Solange nicht alle Checks mit
     kritischer Zuordnung kritisch sind, ist der Service höchstens im
     *Teilausfall*; Warnungen zählen höchstens als *Eingeschränkte Leistung*.
5. Die Vorschau zeigt den resultierenden Status, bevor du speicherst.

Kunden sehen immer nur den resultierenden Status. Vorfälle und Wartungen
pflegst du getrennt; sie überschreiben den Status aus den Checks (siehe
[Überblick](01-overview.md#wie-ein-service-seinen-status-bekommt)).

## Check-Bündel: mehrere Nodes stimmen ab

Überwachst du dasselbe Ziel von mehreren Orten aus, zum Beispiel mit zwei oder
drei Uptime-Kuma-Instanzen in verschiedenen Rechenzentren, soll ein einzelner
Node deine Statusseite nicht in einen Ausfall versetzen können: Vielleicht ist
nur sein eigenes Netz gestört. Ein **Check-Bündel** fasst einen Check pro Node
zu einem Check zusammen, über den eine **Mehrheitsabstimmung** entscheidet.

**Wann ein Bündel passt:** Die Checks messen *dasselbe* von *verschiedenen*
Orten aus. Für verschiedene Komponenten (Webserver, Datenbank, …) verknüpfst
du die Checks weiterhin direkt mit dem Service und nutzt die Zusammenfassung
(schlechtester Check / Quorum).

**Bündel anlegen:**

1. Leg jeden Monitoring-Node als eigene Quelle an (z. B. *Kuma Frankfurt*,
   *Kuma Amsterdam*, *Kuma New York*).
2. **Monitoring → Bündel → Neues Bündel**: Gib einen Namen ein, wähl dann für
   jeden Node den Check, der das Ziel überwacht, und klick auf
   **Hinzufügen**. Die Liste zeigt Uptime-Kuma-Quellen; über den Filter kannst
   du einen anderen Quelltyp wählen.
3. Leg die **Stimmen** jedes Mitglieds fest (ganze Zahl, mindestens 1). Gib
   einem Node mehr Stimmen, wenn du ihm mehr vertraust, etwa weil er an einem
   besser angebundenen Standort läuft.
4. Speichere und verknüpfe das Bündel im Service wie jeden anderen Check
   (**Checks verknüpfen**, nach dem Bündelnamen suchen). Verknüpfe die
   einzelnen Node-Checks nicht zusätzlich, sonst kann ein einzelner Node den
   Service weiterhin verändern.

**So funktioniert die Abstimmung:** Es zählen nur Nodes, die gerade
**melden**. Ein Node meldet nicht, wenn seine Quelle deaktiviert ist, seine
letzte Abfrage fehlgeschlagen ist, sein Check *Unbekannt* ist oder sein
Node verstummt ist: bei abgefragten Quellen weder eine erfolgreiche Abfrage
noch ein neues Ergebnis innerhalb von 3 Abfrageintervallen (mindestens
5 Minuten), bei reinen Webhook-Quellen standardmäßig seit einer Stunde kein
Ergebnis. Eine erfolgreiche Abfrage reicht, ein Icinga-Check, der vor
6 Minuten zuletzt lief, zählt also weiter, solange Icinga antwortet.
Von den Stimmen der meldenden Nodes gilt:

- mehr als die Hälfte sagt *down* → das Bündel ist **kritisch**;
- sonst sagt mehr als die Hälfte *down* oder *pending/Warnung* → **Warnung**;
- sonst → **OK**;
- kein Node meldet → **Unbekannt** (mit der Standard-Zuordnung ignoriert).

Genau die Hälfte ist **keine** Mehrheit. Beispiele mit drei Nodes, Frankfurt
2 Stimmen, Amsterdam und New York je 1 Stimme (4 Stimmen):

| Frankfurt | Amsterdam | New York | Bündel |
| --- | --- | --- | --- |
| down | up | up | OK (2 von 4, genau die Hälfte) |
| down | down | up | kritisch (3 von 4) |
| up | down | down | OK (2 von 4) |
| down | meldet nicht | up | kritisch (2 von 3 meldenden Stimmen) |
| down | pending | up | Warnung (3 von 4 down oder pending) |

Die Seite **Bündel** zeigt jedes Bündel mit seinem aktuellen Ergebnis und pro
Node die Stimmen, den Zustand und ob (und warum nicht) er mitzählt. Sie
aktualisiert sich von selbst. All das ist intern; Kunden sehen nur den
resultierenden Service-Status.

## Historie importieren

Die Statusseite zeichnet Historie ab dem Moment auf, in dem ein Check
angebunden ist. Bei einer neuen Installation sind die Uptime-Balken deshalb
zunächst leer. Um die Zeit davor zu füllen, importierst du die Historie, die
deine Monitoring-Systeme schon haben:

| System | Gelesen aus | Was du brauchst |
| --- | --- | --- |
| Uptime Kuma | Heartbeats (dieselbe API wie die Weboberfläche) | einen Uptime-Kuma-Login, bei aktivierter 2FA zusätzlich den Code |
| Icinga 2 | der Icinga-DB-Datenbank (MySQL/MariaDB oder PostgreSQL) | einen Datenbankbenutzer mit Lesezugriff |
| openITCockpit | der Statushistorie-API | nichts weiter (den API-Key der Quelle); stell die Zeitzone des API-Benutzers auf UTC |
| jede Quelle | einer CSV-Datei, die du hochlädst | die Datei |

1. Öffne die Quelle unter **Monitoring** und klick im Kasten
   **Historie-Import** auf **Historie importieren**.
2. Wähl den Zeitraum und gib bei Uptime Kuma und Icinga 2 die Zugangsdaten
   ein. Sie werden nur für diesen Import genutzt und nicht gespeichert. Wenn du
   regelmäßig importierst, kannst du sie stattdessen verschlüsselt in der
   Quelle hinterlegen (Abschnitt **Historie-Import** im Formular der Quelle).
3. Klick auf **Vorschau laden**. Der Server liest die Historie im Hintergrund;
   du kannst den Dialog schließen und später zurückkommen.
4. Prüf die Vorschau: Pro Service siehst du, wie lange keine Daten vorlagen,
   wie viel gefüllt wird, die Ausfallzeit und die Uptime im Zeitraum vorher
   und nachher. Mit **Importieren** schreibst du sie, mit **Verwerfen**
   verwirfst du sie.

Darauf kannst du dich verlassen:

- **Es werden nur Lücken gefüllt.** Historie, die die Statusseite selbst
  aufgezeichnet hat, bleibt immer unverändert. Meist wird nur die Zeit vor dem
  Go-live gefüllt.
- **Dieselben Regeln wie live.** Die importierten Check-Zustände laufen durch
  deine aktuellen Verknüpfungen, Zuordnungen, die Aggregation und die
  Check-Bündel; Wartungen und Vorfälle aus dieser Zeit zählen ebenfalls.
  Services mit manuellem Status bleiben unverändert.
- **Wiederholen ist gefahrlos.** Derselbe Import ein zweites Mal ändert
  nichts; ein späterer Import desselben Zeitraums ersetzt die zuvor
  importierten Daten (zum Beispiel, nachdem du eine zweite Quelle importiert
  hast, die dieselben Services speist).
- Jeder Import landet im Audit-Log.

Das CSV-Format und die Details je System findest du in der
[Adapter-Dokumentation](../../adapters/README.md#history-import) (Englisch).

## Tipps

- Downtimes und Acknowledgements im Monitoring ändern den übernommenen Zustand
  nicht. Kündige geplante Arbeiten als **Wartung** in OpenStatusPage an; sie
  hat Vorrang vor den Checks der betroffenen Services.
- Soft-States (Icinga 2) und Wiederholungen werden ignoriert; es zählen nur
  Hard-States, damit kurzes Flattern nicht auf der öffentlichen Seite landet.
- Bei Uptime Kuma mit Pull entfernt das Pausieren eines Monitors seinen Check
  (samt Verknüpfungen) bei der nächsten Abfrage.
- Wird ein Check entfernt, verschwinden auch seine Verknüpfungen. Hat ein
  Service plötzlich keine Checks mehr, such nach umbenannten Hosts oder
  Monitoren.
- Ingest-Endpunkte sind auf 120 Anfragen pro Minute und Quelle begrenzt.
  Fasse viele Ergebnisse in einer Anfrage zusammen (bis zu 5000 Checks,
  5 MiB).
