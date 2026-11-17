# Tägliche Arbeit: Vorfälle und Wartungen

Redakteure und Administratoren informieren Kunden über **Vorfälle**
(ungeplante Störungen) und **Wartungen** (geplante Arbeiten). Beides erscheint
auf der öffentlichen Seite, im Verlauf, in den RSS-/Atom-Feeds und, falls
aktiviert, in [E-Mails an Abonnenten](07-email-subscriptions.md).

Zeiten gibst du in der Zeitzone deines Browsers ein (sie steht unter den
Datumsfeldern); gespeichert wird in UTC.

## Vorfälle

### Einen Vorfall melden

**Vorfälle → Neuer Vorfall**:

| Feld | Hinweise |
| --- | --- |
| Titel | Kurz und für Kunden verständlich, z. B. „Erhöhte Fehlerraten bei der API“. |
| Status | *Wird untersucht*, *Ursache identifiziert*, *Wird beobachtet* oder *Behoben*. |
| Auswirkung | Gesamtschwere, die beim Vorfall angezeigt wird (keine, gering, hoch, kritisch). |
| Nachricht | Das erste öffentliche Update. Kurz und sachlich halten. |
| Betroffene Services | Services auswählen und angeben, wie stark sie jeweils betroffen sind (z. B. *Teilausfall*). |
| Betroffene Standorte | Optional: zugehörige Rechenzentrumsstandorte. |
| Beginn | Wann die Störung angefangen hat; standardmäßig jetzt. |
| Auf der öffentlichen Statusseite sichtbar | Versteckte Vorfälle siehst nur du in der Verwaltung; sie ändern keine öffentlichen Status. |
| Abonnenten benachrichtigen | Schickt eine E-Mail an passende Abonnenten (standardmäßig an, nur bei öffentlichen Vorfällen). |

Solange der Vorfall offen ist, zeigt jeder betroffene Service mindestens den
Status, den du für ihn gewählt hast. Betreffen mehrere Vorfälle einen
Service, gilt der schlechteste Status.

### Kunden auf dem Laufenden halten

Öffne den Vorfall und nutze **Update veröffentlichen**. Jedes Update hat einen
Status und eine Nachricht und erscheint im öffentlichen Verlauf. Mit
**Betroffene Services anpassen** änderst du im selben Schritt die betroffenen
Services und ihren Status, etwa wenn aus einem Ausfall eine eingeschränkte
Leistung wird.

Bewährt hat sich:

- Das erste Update früh veröffentlichen, auch wenn die Ursache noch unklar ist.
- Beschreiben, was Kunden merken, nicht, was intern kaputt ist. Keine
  Hostnamen, internen Systeme oder Monitoring-Details nennen.
- Regelmäßig Updates veröffentlichen und ankündigen, wann das nächste kommt.

Bestehende Updates kannst du bearbeiten oder löschen (ein Vorfall behält
mindestens ein Update). Bearbeitungen verschicken keine E-Mails.

### Beheben

Veröffentliche ein Update mit dem Status **Behoben** oder nutze **Beheben**.
Der Vorfall wird geschlossen, die Services kehren zu ihrem überwachten Status
zurück, und der Vorfall bleibt im öffentlichen Verlauf. Ein späteres Update
mit einem anderen Status öffnet ihn wieder.

Beim Löschen verschwindet ein Vorfall vollständig aus dem öffentlichen
Verlauf. Beheben ist meist die bessere Wahl; lösche nur Testeinträge oder
Irrtümer.

## Wartungen

### Planen

**Wartungen → Wartung planen**:

| Feld | Hinweise |
| --- | --- |
| Titel, Beschreibung | Öffentlich. Beschreibe, was passiert und womit Kunden rechnen müssen. |
| Geplanter Beginn / Geplantes Ende | Der Wartungszeitraum. |
| Automatisch starten | Wechselt zum geplanten Beginn auf *Läuft*. |
| Automatisch abschließen | Wechselt zum geplanten Ende auf *Abgeschlossen*. |
| Betroffene Services | Zeigen *Wartung*, solange die Wartung läuft. |
| Betroffene Standorte | Optional. |
| Auf der öffentlichen Statusseite sichtbar | Versteckte Wartungen erscheinen nicht öffentlich und ändern keine Status. |
| Abonnenten benachrichtigen | Kündigt die Wartung per E-Mail an und wird für spätere Benachrichtigungen **gespeichert** (siehe unten). |

Geplante Wartungen stehen in der öffentlichen Übersicht. Ist der Zeitraum beim
Speichern schon erreicht, startet (und endet) die Wartung sofort.

### Automatischer Start und Abschluss

Der Hintergrund-Worker prüft alle 30 Sekunden, ob ein Zeitraum begonnen hat
oder vorbei ist, und setzt bei Wartungen mit *Automatisch starten* bzw.
*Automatisch abschließen* den Status. Diese automatischen Updates haben keinen
eigenen Text; öffentliche Seite und E-Mails zeigen einen Standardsatz wie „Die
Wartung hat begonnen.“

Dafür muss ein Worker laufen (`WORKER_ENABLED=true` auf einer Instanz, das ist
der Standard). Von Hand geht es jederzeit mit **Jetzt starten**,
**Abschließen** oder **Wartung absagen** oder mit einem Update, das den Status
setzt.

Solange eine öffentliche Wartung läuft, zeigen ihre Services *Wartung*, selbst
wenn ihre Checks fehlschlagen. Genau so blendest du geplante Unterbrechungen
aus dem Status aus den Checks aus.

### Ändern und absagen

**Wartung bearbeiten** ändert Titel, Beschreibung, Zeitraum, Services,
Sichtbarkeit und die gespeicherte Wahl bei **Abonnenten benachrichtigen**.
Beim Speichern wird keine E-Mail verschickt. Zum Verschieben änderst du den
Zeitraum (bei einem späteren Beginn bekommen Abonnenten eine neue
Erinnerung); fällt eine Wartung aus,
nutze **Wartung absagen**, damit Kunden sehen, dass sie nicht stattfindet.
Löschen entfernt sie vollständig.

## Die Checkbox „Abonnenten benachrichtigen“

Jedes Formular, das einen Vorfall oder eine Wartung anlegt oder ein Update
veröffentlicht, hat die Checkbox **Abonnenten benachrichtigen**: **Neuer
Vorfall**, **Update veröffentlichen**, **Beheben**, **Wartung planen**,
**Jetzt starten**, **Abschließen** und **Wartung absagen**. Sie ist
standardmäßig angehakt.

- E-Mails gibt es nur für **öffentliche** Vorfälle und Wartungen. Versteckte
  lösen nie eine E-Mail aus, egal was die Checkbox sagt.
- E-Mails gehen nur raus, solange E-Mail-Abonnements in den Einstellungen
  aktiviert sind (**E-Mail-Abonnements anbieten**).
- Bei Vorfällen und bei Updates, die du selbst veröffentlichst, gilt die
  Checkbox nur für diesen einen Schritt: Nimm den Haken für kleine
  Korrekturen heraus.
- Bei Wartungen wird die Wahl mit der Wartung **gespeichert**. Sie steuert die
  Ankündigung und auch die späteren automatischen E-Mails: die
  [Erinnerung](07-email-subscriptions.md#wartungserinnerungen) vor dem
  Zeitraum sowie den automatischen Start und Abschluss. Nimm den Haken heraus,
  wenn niemand von der Wartung erfahren muss; unter **Wartung bearbeiten**
  kannst du die gespeicherte Wahl später ändern (das allein verschickt
  nichts). Die Detailseite der Wartung zeigt die gespeicherte Wahl und wann
  die Erinnerung eingereiht wurde; eine Wartung ohne Benachrichtigungen ist
  mit *Keine E-Mail-Benachrichtigungen* markiert.
- Das Bearbeiten eines Vorfalls, einer Wartung oder eines bestehenden
  Updates verschickt nie eine E-Mail.

Wer die E-Mail bekommt, hängt von den betroffenen Services ab, siehe
[E-Mail-Abonnements](07-email-subscriptions.md#wer-bekommt-was).

## Rollen

Redakteure dürfen Vorfälle und Wartungen anlegen und ändern und alles andere
lesen. Services, Gruppen, Standorte, Monitoring, Einstellungen, Benutzer und
API-Tokens verwalten Administratoren; siehe
[Benutzer und Zugriff](08-users-and-access.md).
