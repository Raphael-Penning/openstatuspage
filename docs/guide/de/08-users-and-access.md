# Benutzer und Zugriff

Die öffentliche Statusseite braucht nie eine Anmeldung. Die Verwaltung unter
`/admin` und die Admin-API sind für dein Team.

## Rollen

| | Redakteur | Administrator |
| --- | --- | --- |
| Vorfälle und Wartungen | anlegen, aktualisieren, löschen | anlegen, aktualisieren, löschen |
| Verlaufskorrekturen | anlegen, aktualisieren, löschen | anlegen, aktualisieren, löschen |
| Services, Gruppen, Standorte, Checks | lesen | verwalten |
| Monitoring-Quellen | – | verwalten |
| Einstellungen, E-Mail-Abonnenten | – | verwalten |
| Benutzer und API-Tokens | – | verwalten |
| Audit-Log | – | lesen |
| Hilfe | lesen | lesen |

Gib allen, die nur über Vorfälle und Wartungen informieren (z. B. dem Service
Desk), die Rolle Redakteur, und halte die Zahl der Administratoren klein.

## Lokale Konten

**Administration → Benutzer** (Administratoren):

- Benutzer mit Name, E-Mail, Rolle und Passwort (mindestens 10 Zeichen)
  anlegen. Für Konten, die nur Single Sign-On nutzen, bleibt das Passwort leer.
- Ein neues Passwort meldet den Benutzer überall ab und widerruft die
  API-Tokens, die er angelegt hat.
- Du kannst dich nicht selbst löschen, deine eigene Rolle nicht ändern und den
  letzten Administrator nicht entfernen.

Eigenes Passwort, Sprache und Darstellung ändert jeder Benutzer im
Benutzermenü (unten links).

Sitzungen laufen nach `SESSION_TTL_HOURS` (Standard 168 Stunden = 7 Tage) ohne
Aktivität ab; aktive Sitzungen verlängern sich automatisch, aber nie über
`SESSION_MAX_AGE_HOURS` (Standard 720 Stunden = 30 Tage) nach der Anmeldung
hinaus. Danach muss sich jeder neu anmelden. Die Anmeldung ist auf 10 Versuche
pro Minute und Client-IP begrenzt; zusätzlich muss nach wiederholten
Fehlversuchen für ein Konto dessen Anmeldung kurz warten (höchstens eine
Minute), egal von welcher IP.

Ausgesperrt? Mit dem Befehl `create-user` setzt du ein neues Passwort, siehe
[Installation](02-installation.md#der-erste-administrator). Der Befehl meldet
den Benutzer auch überall ab und widerruft die API-Tokens, die er angelegt
hat; damit setzt du ein kompromittiertes Konto vom Server aus zurück.

## Single Sign-On (OIDC)

Die Verwaltung unterstützt die Anmeldung über beliebig viele
OpenID-Connect-Anbieter, z. B. Keycloak, Authentik, Microsoft Entra ID, Okta
oder Zitadel. Jeder aktive Anbieter bekommt einen eigenen Button auf der
Anmeldeseite; die Anmeldung per Passwort bleibt verfügbar, solange du sie nicht
abschaltest.

### Anbieter in der Verwaltung hinzufügen

1. Öffne **Administration → Single Sign-On** und wähle **Anbieter
   hinzufügen**. Trage einen Namen (steht auf dem Button), die Issuer-URL, die
   Client-ID und das Client-Secret des Clients ein, den du beim Identity
   Provider registriert hast. Nimm den Haken bei **Aktiv** vorerst heraus.
2. **Konfiguration testen** prüft, ob der Server den Identity Provider
   erreicht, und zeigt seine Endpunkte.
3. Speichere. Der Dialog zeigt jetzt die **Redirect-URI** dieses Anbieters,
   z. B. `https://status.example.com/api/auth/oidc/<Anbieter-ID>/callback`.
   Trage sie beim Identity Provider ein und setze dann den Haken bei **Aktiv**.

Das Client-Secret wird verschlüsselt gespeichert und nie wieder angezeigt; lass
das Feld beim Bearbeiten leer, um es zu behalten. Eine neue **Issuer-URL**
braucht das Client-Secret erneut und entfernt die Verknüpfungen des Anbieters
mit Benutzerkonten: Ein anderer Issuer ist ein anderer Identity Provider.

**Benutzer und Rollen** eines Anbieters:

- **Benutzer bei der ersten Anmeldung anlegen**: standardmäßig aus. Ist es
  an, werden Benutzer nur für E-Mail-Adressen angelegt, die der Identity
  Provider als bestätigt markiert.
- **Bestehende Konten per E-Mail verknüpfen**: standardmäßig aus, dann
  erreicht ein Anbieter nur Konten, die schon mit ihm verknüpft sind. Ist es
  an, wird ein Benutzer, den es in OpenStatusPage schon gibt, bei der ersten
  Anmeldung über eine bestätigte E-Mail-Adresse verknüpft und bekommt das
  Konto samt Rolle. Schalte es nur für einen Identity Provider ein, der
  Adressen selbst bestätigt und bei dem Benutzer sie nicht ändern können, oder
  schalte es wieder aus, sobald alle verknüpft sind.
- **Erlaubte E-Mail-Domains**: optional; nur bestätigte Adressen dieser
  Domains können sich über diesen Anbieter anmelden.
- **Rollen-Claim** und **Rollenzuordnung**: der Claim mit den Gruppen oder
  Rollen (z. B. `groups`, `roles` oder `realm_access.roles`) und welche Werte
  *Admin*, *Redakteur* oder *Kein Zugriff* gewähren. *Kein Zugriff* gewinnt
  immer.
- **Rolle ohne passenden Wert**: *Redakteur* oder *Kein Zugriff*.
- **Rolle aktualisieren**: *bei jeder Anmeldung* (der Identity Provider
  entscheidet) oder *nur beim Anlegen des Benutzers* (danach verwaltest du die
  Rolle hier).

Lass einen öffentlichen oder mandantenübergreifenden Identity Provider nie
Benutzer anlegen ohne Rollenzuordnung, erlaubte Domains oder *Kein Zugriff* als
Standardrolle: Jedes Konto, das er anmelden kann, würde Redakteur. Das Formular
warnt dich in diesem Fall.

### Der Anbieter aus der Umgebung

Der Anbieter, den du wie bisher über Umgebungsvariablen konfigurierst,
funktioniert weiter und erscheint mit dem Hinweis **Aus der Umgebung** (nur
lesbar). Seine Redirect-URI bleibt `${BASE_URL}/api/auth/oidc/callback`:

```bash
OIDC_ISSUER_URL=https://idp.example.com/realms/example
OIDC_CLIENT_ID=openstatuspage
OIDC_CLIENT_SECRET=<Client-Secret>
OIDC_ADMIN_GROUP=statuspage-admins
OIDC_EDITOR_GROUP=statuspage-editors
```

Mitglieder von `OIDC_ADMIN_GROUP` werden Administratoren, Mitglieder von
`OIDC_EDITOR_GROUP` Redakteure. Ist `OIDC_EDITOR_GROUP` gesetzt, werden
Benutzer ohne eine der Gruppen abgewiesen; ohne sie darf sich jedes Konto des
Identity Providers, das zu einem Benutzer passt, als Redakteur anmelden.
`OIDC_AUTO_CREATE_USERS=true` legt Benutzer bei der ersten Anmeldung an (nur mit
bestätigter E-Mail-Adresse).

### Rollen und Verknüpfung

Wird die Rolle bei jeder Anmeldung aktualisiert und verliert jemand so die
Administratorrolle, werden seine Administrator-API-Tokens widerrufen, genau wie
bei einer Änderung in der Verwaltung. Der letzte Administrator wird so nie
herabgestuft; stattdessen schreibt der Server eine Warnung ins Log.

Ein Benutzer kann mit mehreren Anbietern verknüpft sein (eine Identität pro
Anbieter). Aktualisieren mehrere davon die Rolle bei jeder Anmeldung,
entscheidet die letzte Anmeldung; ordne die Gruppen deshalb überall gleich zu.

Funktioniert SSO und ist ein SSO-Benutzer Administrator, kannst du die
Anmeldung per Passwort mit `LOCAL_LOGIN_ENABLED=false` abschalten. Den letzten
aktiven Anbieter kannst du dann nicht mehr deaktivieren oder löschen. Geht ein
Anbieter trotzdem kaputt, setze kurz `LOCAL_LOGIN_ENABLED=true`, melde dich
mit Passwort an und repariere ihn.

Offboarding: Der Identity Provider wird nur bei der Anmeldung gefragt. Wen du
dort entfernst oder sperrst, der behält eine bestehende Sitzung bis spätestens
`SESSION_MAX_AGE_HOURS`, und seine API-Tokens bleiben gültig. Ein verknüpfter
Benutzer mit lokalem Passwort kann sich damit außerdem weiter anmelden, solange
`LOCAL_LOGIN_ENABLED=false` nicht gesetzt ist, und wer mit mehreren Anbietern
verknüpft ist, kann die anderen nutzen. Wenn jemand geht, lösche den
Benutzer deshalb immer auch unter **Administration → Benutzer**: Das beendet
alle Sitzungen und widerruft seine Tokens sofort.

Hinweise zu einzelnen Anbietern, alle Einstellungen und Variablen und die
Fehlercodes auf der Anmeldeseite stehen in [`docs/oidc.md`](../../oidc.md) (Englisch).

## API-Tokens

Skripte und Integrationen nutzen die Admin-API mit einem API-Token statt einer
Anmeldung. **Administration → API-Tokens** (Administratoren):

1. Lege ein Token mit aussagekräftigem Namen und einer Rolle (Redakteur oder
   Administrator) an. Das Token hat genau die Rechte eines Benutzers mit
   dieser Rolle.
2. Kopiere das Token (es beginnt mit `osp_`). Es wird nur einmal angezeigt und
   als Hash gespeichert.
3. Sende es als Bearer-Token:

   ```bash
   curl -fsS https://status.example.com/api/admin/incidents \
     -H "Authorization: Bearer $OSP_API_TOKEN"
   ```

Die API spricht [JSON:API 1.1](https://jsonapi.org/format/1.1/) (seit 0.2.0):
Antworten sind Dokumente mit `data`, `included`, `meta` und `links`, Fehler
stehen in `errors`. Anfragen mit Inhalt sendest du mit
`Content-Type: application/vnd.api+json` und packst die Felder in `data`. So
meldest du zum Beispiel eine Störung:

```bash
curl -fsS https://status.example.com/api/admin/incidents \
  -H "Authorization: Bearer $OSP_API_TOKEN" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{"data":{"type":"incidents","attributes":{"title":"Langsame Anmeldung","message":"Wir untersuchen das Problem."}}}'
```

Änderungen schickst du per `PATCH`; dabei ändern sich nur die Felder, die du
mitsendest.

Alle Endpunkte, ihre Parameter und die nötige Rolle findest du unter **API** in
der Verwaltung (neben **Hilfe**). Dort kannst du Anfragen auch mit deiner
Sitzung ausprobieren; Anfragen, die Daten ändern, musst du vorher bestätigen.
Codegeneratoren und API-Werkzeuge lesen dieselbe Beschreibung als OpenAPI 3.1
unter `https://status.example.com/api/openapi.json` (mit Token bekommst du die
ganze API, ohne nur den öffentlichen Teil).

Tokens werden automatisch widerrufen, wenn der Benutzer gelöscht wird, der sie
angelegt hat; Administrator-Tokens auch dann, wenn dieser die
Administratorrolle verliert. Ein Token, das mit einem anderen Token angelegt
wurde, gehört dem Besitzer dieses Tokens. Widerrufe Tokens, die nicht mehr gebraucht
werden; die Liste zeigt, wann jedes Token zuletzt verwendet wurde. Änderungen
über ein Token stehen mit dem Token-Namen im Audit-Log.

Die API beschreibt [`docs/api.md`](../../api.md) (Englisch).

Ingest-Tokens von Monitoring-Quellen sind etwas anderes: Sie erlauben nur das
Senden von Check-Ergebnissen für ihre Quelle und werden an der Quelle
verwaltet.

## Audit-Log

**Administration → Audit-Log** listet jede Änderung in der Verwaltung oder
über die API auf, einschließlich Anmeldungen, mit Benutzer, Zeitpunkt und
betroffenem Objekt.
