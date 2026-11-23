# Überblick und Konzepte

OpenStatusPage ist eine selbst gehostete Statusseite. Deine Kunden sehen den
Zustand der Services, die du anbietest; deine interne Infrastruktur (Hosts,
Checks, Monitoring-Systeme) bleibt privat. Diese Anleitung erklärt, wie du die
Anwendung einrichtest und betreibst.

Die Anleitung steht auch in der Verwaltung unter **Hilfe** bereit, in der
Sprache, die du dort eingestellt hast.

## Die zwei Hälften der Anwendung

| Teil | URL | Für wen |
| --- | --- | --- |
| Öffentliche Statusseite | `/` (z. B. `https://status.example.com/`) | Kunden, ohne Anmeldung |
| Verwaltung | `/admin` | dein Team, mit Anmeldung |

Beides liefert ein einziger Node.js-Prozess aus, zusammen mit der HTTP-API
(`/api/...`), den RSS- und Atom-Feeds (`/feed.rss`, `/feed.atom`) und einem
Hintergrund-Worker für zeitgesteuerte Aufgaben. Er erscheint als
Container-Image für Docker Compose, einen einzelnen Container oder
Kubernetes und läuft auch direkt aus dem Quellcode.

## Bausteine

**Services** sind das, was deine Kunden interessiert, zum Beispiel
„Webanwendung“, „Öffentliche API“ oder „DNS“. Jeder Service hat einen
öffentlichen Status:

| Status | Bedeutung |
| --- | --- |
| Betriebsbereit | alles funktioniert |
| Wartung | eine geplante Wartung läuft |
| Eingeschränkte Leistung | langsamer oder teilweise beeinträchtigt |
| Teilausfall | ein Teil der Kunden oder Funktionen ist betroffen |
| Schwerer Ausfall | der Service ist nicht erreichbar |

Ein Service ist entweder ein *Service* oder eine *Website* (mit öffentlicher
URL, die als Link erscheint). Jeder Service kann öffentlich oder versteckt
sein; versteckte Services siehst nur du in der Verwaltung.

**Gruppen** gliedern die öffentliche Service-Liste, etwa in „Plattform“,
„Netzwerk“ und „Websites“. Eine Gruppe kann auf der öffentlichen Seite
standardmäßig eingeklappt sein.

**Standorte** sind Rechenzentren oder Points of Presence. Services werden mit
den Standorten verknüpft, an denen sie laufen; die öffentliche Karte zeigt
jeden Standort mit dem schlechtesten Status seiner öffentlichen Services. Du
kannst einem Standort den Status auch fest vorgeben.

**Checks** kommen aus deinen Monitoring-Systemen (Icinga 2, Uptime Kuma,
openITCockpit oder jedes System, das einen Webhook senden kann). Eine
**Monitoring-Quelle** ist die Verbindung zu einem solchen System. Checks sind
intern: Namen, Hosts, Ausgaben und selbst ihre Anzahl erscheinen nie auf der
öffentlichen Seite oder in der öffentlichen API.

**Vorfälle** sind ungeplante Störungen, über die du informierst. Ein Vorfall
hat einen Titel, einen Status (*Wird untersucht*, *Ursache identifiziert*,
*Wird beobachtet*, *Behoben*), eine Auswirkung, betroffene Services und eine
Abfolge von Updates.

**Wartungen** kündigen geplante Arbeiten mit einem Zeitraum an. Solange eine
Wartung läuft, zeigen ihre Services auf der öffentlichen Seite *Wartung*.

**Abonnenten** bekommen E-Mails zu öffentlichen Vorfällen und Wartungen, wenn
du [E-Mail-Abonnements](07-email-subscriptions.md) aktivierst. Webhooks (Discord,
Slack, Teams, generisches JSON) und SMS können dieselben Benachrichtigungen
erhalten, siehe [Webhooks und SMS](14-webhooks-and-sms.md).

## Wie ein Service seinen Status bekommt

Jeder Service hat eine *Statusquelle*:

- **Automatisch**: Der Status ergibt sich aus den verknüpften Checks. Jede
  Verknüpfung ordnet dem Check-Zustand einen Service-Status zu (Standard:
  Warnung → Eingeschränkte Leistung, Kritisch → Schwerer Ausfall, Unbekannt →
  ignoriert).
- **Manuell**: Du setzt den Status selbst; Checks werden ignoriert.

Auf diesen Grundstatus wirken:

1. Eine **laufende öffentliche Wartung** ersetzt ihn durch *Wartung*.
2. **Offene öffentliche Vorfälle** setzen den Status, den sie für den Service
   angeben; der schlechteste Status gewinnt.

Wie mehrere Checks zusammengefasst werden, stellst du pro Service ein:

- **Schlechtester Check**: Der schlechteste zugeordnete Status aller Checks
  gilt.
- **Redundanz (Quorum)**: Für redundante Setups. Ein ausgefallener Check führt
  höchstens zu einem *Teilausfall*, solange nicht alle Checks mit kritischer
  Zuordnung gleichzeitig kritisch sind; Warnungen zählen höchstens als
  *Eingeschränkte Leistung*.

Die Verfügbarkeitsbalken auf der öffentlichen Seite werden pro UTC-Tag aus der
Statushistorie berechnet. *Eingeschränkte Leistung* und *Wartung* zählen als
verfügbar. [Korrekturen](06-daily-work.md#den-verlauf-korrigieren) (eine
vergessene Wartung, ein Fehlalarm) werden über die aufgezeichnete Historie
gelegt; die aufgezeichneten Daten selbst werden nie verändert.

Wie du Services aus Checks zusammensetzt, steht unter
[Monitoring anbinden](05-monitoring.md).

## Datenschutzmodell

Das Grundversprechen lautet: **Kunden sehen Services, niemals Infrastruktur.**

- Monitoring-Quellen, Checks, Hosts, Check-Ausgaben und Zugangsdaten gibt es
  nur in der Verwaltung und in der Admin-API (`/api/admin/...`).
- Die öffentliche API (`/api/public/...`) und die Feeds liefern ausschließlich
  öffentliche Services, Gruppen, Standorte, Vorfälle und Wartungen, Feld für
  Feld. Versteckte Objekte und alles rund ums Monitoring verlassen den Server
  nie.
- Zugangsdaten für das Monitoring werden verschlüsselt gespeichert
  (AES-256-GCM, Schlüssel abgeleitet aus `SECRET_KEY`) und nach dem Speichern
  nie wieder angezeigt.
- Sitzungs-, API- und Ingest-Tokens werden nur als Hash gespeichert.
- E-Mail-Adressen von Abonnenten sehen nur Administratoren.

## Wie es weitergeht

1. [Installiere und deploye](02-installation.md) die Anwendung.
2. Stelle sie [hinter einen Reverse Proxy mit HTTPS](03-reverse-proxy.md).
3. Prüfe die [Konfiguration](04-configuration.md) und die Einstellungsseite.
4. Binde dein [Monitoring](05-monitoring.md) an und lege Services an.
5. Lerne die [tägliche Arbeit](06-daily-work.md) mit Vorfällen und Wartungen
   kennen und wie die [öffentliche Seite](12-public-page.md) Suchmaschinen und
   Besucher ohne JavaScript erreicht.
6. Plane [Sicherungen, Updates und die Überwachung](09-operations.md) der
   Statusseite selbst und geh die [Sicherheits-Checkliste](11-security-checklist.md)
   durch.
