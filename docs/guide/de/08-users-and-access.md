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
- Ein neues Passwort meldet den Benutzer überall ab.
- Du kannst dich nicht selbst löschen, deine eigene Rolle nicht ändern und den
  letzten Administrator nicht entfernen.

Eigenes Passwort, Sprache und Darstellung ändert jeder Benutzer im
Benutzermenü (unten links).

Sitzungen laufen nach `SESSION_TTL_HOURS` (Standard 168 Stunden = 7 Tage) ohne
Aktivität ab; aktive Sitzungen verlängern sich automatisch, aber nie über
`SESSION_MAX_AGE_HOURS` (Standard 720 Stunden = 30 Tage) nach der Anmeldung
hinaus. Danach muss sich jeder neu anmelden. Die Anmeldung ist auf 10 Versuche
pro Minute und Client-IP begrenzt.

Ausgesperrt? Mit dem Befehl `create-user` setzt du ein neues Passwort, siehe
[Installation](02-installation.md#der-erste-administrator). Der Befehl meldet
den Benutzer auch überall ab; damit setzt du ein kompromittiertes Konto vom
Server aus zurück.

## Single Sign-On (OIDC)

Die Verwaltung unterstützt die Anmeldung über jeden OpenID-Connect-Anbieter,
z. B. Keycloak, Authentik, Microsoft Entra ID, Okta oder Zitadel. Kurzfassung:

1. Registriere beim Identity Provider einen Client mit der Redirect-URI
   `${BASE_URL}/api/auth/oidc/callback`, z. B.
   `https://status.example.com/api/auth/oidc/callback`.
2. Konfiguriere den Server:

   ```bash
   OIDC_ISSUER_URL=https://idp.example.com/realms/example
   OIDC_CLIENT_ID=openstatuspage
   OIDC_CLIENT_SECRET=<Client-Secret>
   OIDC_ADMIN_GROUP=statuspage-admins
   OIDC_EDITOR_GROUP=statuspage-editors
   ```

3. Neu starten. Die Anmeldeseite zeigt einen Button mit der Beschriftung aus
   `OIDC_LABEL` (Standard „Single Sign-On“).

Rollenzuordnung: Mitglieder von `OIDC_ADMIN_GROUP` werden Administratoren,
Mitglieder von `OIDC_EDITOR_GROUP` Redakteure. Ist eine dieser Gruppen
konfiguriert, wird die Rolle bei jeder Anmeldung abgeglichen. Ist
`OIDC_EDITOR_GROUP` gesetzt, werden Benutzer ohne eine der Gruppen abgewiesen;
ohne sie darf sich jedes Konto des Identity Providers, das zu einem Benutzer
passt, als Redakteur anmelden. Die Gruppen stehen im Claim
`OIDC_GROUPS_CLAIM` (Standard `groups`).

Standardmäßig dürfen sich nur Benutzer anmelden, die es in OpenStatusPage
schon gibt (bei der ersten Anmeldung über eine bestätigte E-Mail-Adresse
zugeordnet). `OIDC_AUTO_CREATE_USERS=true` legt Benutzer bei der ersten
Anmeldung an; aktiviere das nur zusammen mit den Gruppen-Variablen, sonst wird
jedes Konto des Identity Providers zum Redakteur.

Funktioniert SSO und ist ein SSO-Benutzer Administrator, kannst du die
Anmeldung per Passwort mit `LOCAL_LOGIN_ENABLED=false` abschalten.

Verliert jemand über die Gruppen die Administratorrolle, werden seine
Administrator-API-Tokens widerrufen, genau wie bei einer Änderung in der
Verwaltung. Der letzte Administrator wird so nie herabgestuft; stattdessen
schreibt der Server eine Warnung ins Log.

Offboarding: Der Identity Provider wird nur bei der Anmeldung gefragt. Wen du
dort entfernst oder sperrst, der behält eine bestehende Sitzung bis spätestens
`SESSION_MAX_AGE_HOURS`, und seine API-Tokens bleiben gültig. Ein verknüpfter
Benutzer mit lokalem Passwort kann sich damit außerdem weiter anmelden, solange
`LOCAL_LOGIN_ENABLED=false` nicht gesetzt ist. Wenn jemand geht, lösche den
Benutzer deshalb immer auch unter **Administration → Benutzer**: Das beendet
alle Sitzungen und widerruft seine Tokens sofort.

Hinweise zu einzelnen Anbietern, alle Variablen und die Fehlercodes auf der
Anmeldeseite stehen in [`docs/oidc.md`](../../oidc.md) (Englisch).

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
