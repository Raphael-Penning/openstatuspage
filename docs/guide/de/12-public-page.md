# Suchmaschinen, KI-Agenten und die öffentliche Seite

Die öffentliche Statusseite soll von allen gefunden, gelesen und benutzt werden
können: von Suchmaschinen, Link-Vorschauen, KI-Assistenten und Besuchern, deren
Browser keine Skripte ausführt. Dieses Kapitel erklärt, was die Seite diesen
Besuchern mitteilt und was du einstellen musst, damit das funktioniert.

## Was du einstellen musst

Für Suchmaschinen zählt nur eine Einstellung: **`PUBLIC_BASE_URL`** (Standard:
`BASE_URL`). Ihr Wert erscheint in jedem Canonical-Link, jeder `hreflang`-Angabe,
jedem Sitemap-Eintrag, in der Zeile `Sitemap:` der `robots.txt`, in den Links der
`llms.txt` und in den strukturierten Daten. Trag die Adresse ein, die deine
Besucher eingeben, mit `https://` und ohne abschließenden Schrägstrich, zum
Beispiel `https://status.example.com`.

- Ein falscher Wert führt dazu, dass Suchmaschinen einen anderen Host indexieren
  oder die Seiten als Duplikate behandeln. Prüfe das nach der Installation einmal,
  indem du `/robots.txt` und `/sitemap.xml` im Browser öffnest.
- Bei einer [geteilten Installation](02-installation.md#geteilte-installation) setzt du
  die Variable auch auf den Instanzen `admin` und `worker`, und zwar auf die
  öffentliche Domain. Die Admin-Domain ist nicht die Statusseite, und das sagt sie
  Suchmaschinen auch (siehe unten).

Die Variable selbst ist in der [Konfiguration](../../configuration.md#server)
beschrieben.

## Was die Seite Suchmaschinen mitteilt

Jede öffentliche Seite beschreibt sich selbst:

- **Titel und Beschreibung.** Jede Seite hat einen eigenen Titel nach dem Muster
  „Seite · Seitenname“. Die Beschreibung stammt aus dem Inhalt der Seite (die
  Beschreibung eines Dienstes, die letzte Vorfall-Meldung, die Beschreibung einer
  Wartung), höchstens 160 Zeichen.
- **Canonical-Link und Sprachen.** Jede Seite nennt ihre kanonische Adresse, klein
  geschrieben und ohne Schrägstrich am Ende; andere Schreibweisen wie
  `/Services/` werden dorthin umgeleitet (`301`). Die Sprachfassungen
  (`?lang=de`, `?lang=en`) sind eigene Seiten und verweisen aufeinander; die
  einfache Adresse gilt als `x-default`. `?lang=` zeigt immer diese Sprache, egal
  was Besucher vorher gewählt haben.
- **Strukturierte Daten (JSON-LD).** Die Übersicht beschreibt die Seite und die
  Organisation dahinter. Die anderen Seiten haben Breadcrumbs. Vorfall- und
  Wartungsseiten werden als Artikel mit Beginn und letzter Änderung beschrieben.
- **Link-Vorschauen.** Open-Graph- und Twitter-Card-Angaben enthalten Seitenname,
  Titel, Beschreibung und das Logo (sofern du eins hinterlegt hast), damit ein
  geteilter Link die richtige Vorschau zeigt.

Seiten, die es nicht gibt (`404`), und die persönlichen Abo-Links (Bestätigen,
Verwalten und Abmelden) tragen `noindex`. Abo-Links sind persönlich und haben
keine kanonische Adresse; deshalb stehen sie auch in keiner Sitemap. Gefilterte,
durchsuchte und weitere Seiten (zum Beispiel `/history?type=incident` oder
`/history?page=2`) tragen `noindex, follow`: Suchmaschinen folgen ihren Links zu
den Vorfällen, nehmen aber nur die einfache Seite auf.

## robots.txt

Die Datei `/robots.txt` wird erzeugt; du bearbeitest sie nicht selbst. Auf der
öffentlichen Statusseite sieht sie so aus (mit deinem Host-Namen):

```text
# Public status page. A summary for language models: https://status.example.com/llms.txt
User-agent: *
Allow: /
Allow: /api/public/
Disallow: /api/public/subscriptions
Disallow: /api/
Disallow: /admin
Disallow: /subscription/
Disallow: /preferences/

Sitemap: https://status.example.com/sitemap.xml
```

- Die Verwaltungsoberfläche, die persönlichen Abo-Links und die API werden nicht
  durchsucht, außer der lesenden öffentlichen API, auf die `llms.txt` Agenten
  verweist. Die öffentlichen Seiten, die Feeds und die Dateien für KI-Agenten
  werden durchsucht.
- Eine Instanz mit `APP_ROLE=admin` (die Verwaltungsseite einer geteilten
  Installation) antwortet mit `Disallow: /` und markiert jede Seite mit
  `noindex`, damit Suchmaschinen sie auslassen.
  Das ist richtig so: Die Admin-Domain ist nicht die Statusseite.
- `Disallow` verhindert das Abrufen, nicht unbedingt die Aufnahme in den Index.
  Der Header und das Meta-Tag `noindex` halten eine Seite aus den
  Suchergebnissen heraus. Deshalb tragen Seiten, die draußen bleiben sollen,
  beides.

Wenn du für bestimmte Crawler eigene Regeln brauchst (zum Beispiel um KI-Bots
das Training zu verbieten), stell eine eigene `robots.txt` auf dem Reverse Proxy
bereit. Dann wird die Datei der App nicht mehr erreicht. Behalte die Zeile
`Sitemap:` bei.

## Sitemaps

`/sitemap.xml` ist ein Sitemap-Index. Er verweist auf diese Sitemaps, jede mit
eigenem `lastmod` und nur mit öffentlichen Seiten:

| Sitemap | Inhalt |
| --- | --- |
| `/sitemap-pages.xml` | Übersicht, Dienste, Verlauf und Standorte, dazu „Abonnieren“, wenn E-Mail-Abos angeboten werden. |
| `/sitemap-incidents-1.xml`, ... | Öffentliche Vorfälle, danach öffentliche Wartungen. Weitere nummerierte Dateien kommen hinzu, wenn es mehr als 5.000 URLs gibt. |
| `/sitemap-services-1.xml`, ... | Ein Eintrag pro öffentlicher Dienstseite. Versteckte Dienste stehen nie darin. |

Jede Datei enthält höchstens 5.000 URLs. Ein langer Verlauf wird deshalb auf
mehrere nummerierte Dateien verteilt, die der Index für dich auflistet. Ein Dienst
oder ein Vorfall trägt den Zeitpunkt seiner letzten Änderung, damit
Suchmaschinen geänderte Seiten erneut besuchen. Die Sitemaps aktualisieren sich
selbst; du pflegst nichts davon.

## Die Sitemap in der Google Search Console einreichen

Google braucht keine Einreichung, aber die Sitemap zeigt dir, was Google findet,
und beschleunigt die Entdeckung. Du brauchst dafür ein Google-Konto.

1. Lege in der [Search Console](https://search.google.com/search-console) eine
   Property für deine Statusseite an. Am besten eine **Domain-Property**
   (`example.com`), die du über einen DNS-`TXT`-Eintrag bestätigst. Den legst du
   im Verwaltungsbereich deines DNS-Anbieters an. Eine URL-Präfix-Property verlangt
   ein HTML-Tag oder eine Datei auf der Website, und die Statusseite hat keine
   Einstellung für ein Bestätigungs-Tag. Wenn du nur ein URL-Präfix nutzen kannst,
   fügst du das Tag über deinen Reverse Proxy hinzu.
2. Öffne in der Property den Punkt **Sitemaps**, trag `sitemap.xml` ein (die
   vollständige Adresse ist `https://status.example.com/sitemap.xml`) und sende ab.
3. Warte ein paar Minuten und lade die Seite neu. Der Status sollte melden, dass
   die Sitemap gelesen wurde, und die Zahl der gefundenen Seiten anzeigen. Google
   liest die Unter-Sitemaps des Index selbst; du reichst sie nicht einzeln ein.
4. Optional kannst du mit der **URL-Prüfung** die Übersichtsseite prüfen. Sie
   sollte die erwartete kanonische Adresse zeigen und als indexierbar gelten.

Die Aufnahme in den Index kann Tage dauern. Meldet die Search Console
„Konnte nicht abgerufen werden“, antwortet die Adresse der Sitemap nicht mit dem
Index. Prüfe dann, ob der Proxy `/sitemap.xml` unverändert durchreicht und ob
`PUBLIC_BASE_URL` stimmt. Die Bing Webmaster Tools akzeptieren dieselbe Adresse.

## Regeln für noindex

| Seite | Im Index | Hinweis |
| --- | --- | --- |
| Übersicht, Dienste, Dienst, Verlauf, Vorfall, Wartung, Standorte | ja | In den Sitemaps aufgeführt. |
| Abonnieren | ja, wenn E-Mail-Abos angeboten werden | In der Sitemap der Seiten aufgeführt. |
| Gefilterte, durchsuchte oder weitere Seiten, Zustände „gesendet“ und Fehler der Abo-Seite | nein | `noindex, follow`, keine kanonische Adresse. |
| Tagesseiten der Verfügbarkeitsbalken (`/services/<dienst>/days/<datum>`) | nein | `noindex, follow`: eine dünne Seite pro Dienst und Tag. In keiner Sitemap. |
| Nicht gefunden (404), auch eine Verlaufsseite hinter der letzten | nein | `noindex`. |
| Bestätigen-, Verwalten- und Abmelden-Links | nein | `noindex`, nicht in einer Sitemap, in der `robots.txt` ausgeschlossen. |
| `/admin` auf einer Instanz, die sie ausliefert | nein | Die Antwort trägt `X-Robots-Tag: noindex, nofollow`. |
| Alle Seiten einer Instanz `admin` | nein | `Disallow: /` in der `robots.txt` und `X-Robots-Tag: noindex, nofollow`. |

Du musst davon nichts einstellen. Versteckte Dienste und interne Checks werden
nie veröffentlicht und können deshalb auch nicht in einem Suchergebnis
erscheinen.

## llms.txt und KI-Agenten

Sprachmodelle und Agenten finden die Seite über diese Dateien, alle werden
erzeugt:

- **`/llms.txt`** ist eine kurze Zusammenfassung im Format von
  [llms.txt](https://llmstxt.org): Name und Beschreibung deiner Seite, die
  öffentlichen Seiten mit je einer kurzen Erklärung, der JSON:API-Endpunkt für den
  Status und die Feeds. Die Datei ändert sich, wenn sich deine Einstellungen oder
  Dienste ändern.
- **`/llms-full.txt`** ist der aktuelle Status als Markdown: der Gesamtstatus, die
  aktiven Vorfälle, geplante Wartungen und jeder öffentliche Dienst. Sie wird etwa
  jede Minute aktualisiert.
- **`/api/public/status`** liefert denselben Status als JSON:API-Dokument für
  Programme. **`/feed.rss`** und **`/feed.atom`** enthalten Vorfälle und
  Wartungen.

Der Text dieser Dateien kommt aus deinen Einstellungen und deinen öffentlichen
Vorfällen. Er wird so maskiert, dass ein Vorfall-Titel keine Überschriften oder
Links in die Dateien einschleusen kann.

## Die Statusseite ohne JavaScript benutzen

Die öffentlichen Seiten funktionieren auch in einem Browser ohne JavaScript, etwa
bei blockierten Skripten, auf älteren Geräten oder in textbasierten Werkzeugen.
Skripte machen die Seite nur bequemer. Ohne sie gilt:

- **Alles wird angezeigt.** Die Übersicht, die Dienste mit ihrer Verfügbarkeit,
  die Seiten zu Vorfällen und Wartungen sowie der Verlauf werden auf dem Server
  erzeugt.
- **Filter sind Formulare und Links.** Die Verlaufsfilter (Art, Dienst, Standort,
  Monat) sind ein Formular mit der Schaltfläche **Anwenden**, die Seitenzahlen
  sind Links. Auch die Dienstsuche und der Statusfilter sind ein Formular
  beziehungsweise Links.
- **Sprache und Design sind Links und Formulare.** Das Sprachmenü verlinkt die
  Seite in jeder Sprache (auf den persönlichen Abo-Seiten ist es ein Formular,
  damit ihr Link in keinem Log landet); die Designwahl ist ein Formular. `System` folgt der
  Einstellung für den dunklen Modus deines Geräts.
- **Aufklappbare Bereiche öffnest du per Klick.** Das Abo-Menü, das Sprachmenü und
  die Dienstgruppen öffnen und schließen sich ohne Skripte.
- **Karte und Balken haben einen Textersatz.** Die Weltkarte zeichnet der Server
  als Bild der Länder mit ihren Markierungen. Die Verfügbarkeitsbalken haben auf
  der Dienstseite eine Tabelle mit denselben Tagen.
- **Jeder Tag eines Verfügbarkeitsbalkens ist ein Link.** Er öffnet die
  Tagesseite: Status und Verfügbarkeit des Tages, wann der Dienst ausgefallen,
  eingeschränkt oder in Wartung war, die Vorfälle und Wartungen des Tages,
  Korrekturen mit ihren öffentlichen Hinweisen und Links zum vorherigen und
  nächsten Tag.
- **Zeiten sind in UTC.** Der Server zeigt Zeiten in UTC. Ein Browser mit
  JavaScript stellt sie nach dem Laden auf die Zeitzone und das Format des
  Besuchers um.
- **Abos funktionieren mit Formularen.** Abonnieren, Bestätigen und Verwalten sind
  einfache Formulare. Fehler werden oben auf der Seite angezeigt.

Ohne JavaScript fehlen nur: die Live-Aktualisierung des Status alle 60 Sekunden,
die interaktive Karte, die Umstellung der Zeitzone und das Schließen der Menüs per
Klick außerhalb oder mit der Escape-Taste.

## Fehlersuche

- **In Suchergebnissen steht noch der alte Titel oder die alte Beschreibung.**
  Suchmaschinen aktualisieren ihre Kopie erst beim nächsten Besuch. Prüfe zuerst
  im Browser den Titel der Seite. Stimmt er, bitte in der Search Console um
  Indexierung.
- **Eine Seite zeigt eine andere Adresse als die im Browser.** `PUBLIC_BASE_URL`
  ist nicht die Adresse, die deine Besucher benutzen. Korrigiere sie und starte die
  App neu.
- **Die Search Console meldet, dass eine Sitemap nicht gelesen werden kann.** Öffne
  `https://status.example.com/sitemap.xml` im Browser. Zeigt sie keinen
  XML-Index, reicht der Proxy den Pfad nicht durch.
- **`/robots.txt` oder eine Sitemap wird lange zwischengespeichert.** Crawler und
  Proxys speichern sie eine Stunde (robots), 15 Minuten (Sitemaps) und wenige
  Minuten (`llms.txt`). Warte oder leere den Cache deines Proxys.
