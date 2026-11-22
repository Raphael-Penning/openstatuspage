# Fehlerbehebung

Fang mit den Logs an (`docker compose logs -f openstatuspage` im Verzeichnis
mit `compose.yaml`, unter Kubernetes
`kubectl -n openstatuspage logs deployment/openstatuspage`) und mit
`GET /api/health`. Für mehr Details setzt du vorübergehend
`LOG_LEVEL=debug`.

## Container-Image

**`docker compose pull` oder `docker pull` scheitert mit „manifest unknown“
oder „not found“.**
Den Tag gibt es nicht. Prüfe `OSP_VERSION` (`1.2.3`, ohne `v`). `latest` und
die Versions-Tags gibt es erst nach dem ersten Release; bis dahin nimmst du
`edge` oder einen `sha-`-Tag. Die vorhandenen Tags stehen auf der
Package-Seite des Repositorys bei GitHub. Unter Kubernetes zeigt der Pod
`ErrImagePull` / `ImagePullBackOff`; die Meldung siehst du mit
`kubectl -n openstatuspage describe pod`.

**Der Pull scheitert mit „denied“ oder „unauthorized“.**
Das Package ist privat. Neue Packages in der GitHub Container Registry sind
oft zunächst privat (etwa bei einem Fork). Stell es in den Package-Einstellungen auf
öffentlich, oder melde dich mit einem Token an, das Packages lesen darf:
`docker login ghcr.io` (unter Kubernetes ein `imagePullSecret`). Eine
abgelaufene Anmeldung in `~/.docker/config.json` führt auch bei öffentlichen
Images zu diesem Fehler; `docker logout ghcr.io` behebt das.

**„no matching manifest for linux/arm/v7“ oder „exec format error“.**
Images gibt es nur für `linux/amd64` und `linux/arm64`. Auf anderen
Plattformen [baust du das Image selbst](02-installation.md#image-selbst-bauen).

**Nach einem Neustart läuft eine andere Version.**
`OSP_VERSION` ist ein mitwandernder Tag (`latest`, `1.2`), und es wurde ein
neueres Image geholt. Leg dich auf ein Release fest, siehe
[Image-Tags](02-installation.md#image-tags).

## Start

**Der Container startet ständig neu mit „Invalid configuration“.**
Die Meldung nennt jede ungültige Variable, z. B. `BASE_URL: Invalid URL` oder
`ADMIN_PASSWORD: Too small: expected string to have >=10 characters`.
`BASE_URL` braucht das Schema (`https://`), `ADMIN_PASSWORD` mindestens
10 Zeichen, `SECRET_KEY` mindestens 32.

**„SECRET_KEY must be set“.**
Im Produktivbetrieb (dem Standard für `NODE_ENV`) ist der Schlüssel Pflicht.
Erzeuge einen mit `openssl rand -base64 48`.

**„SECRET_KEY: is a published example value“.**
Der Schlüssel (oder `SUBSCRIPTION_TOKEN_KEY`) ist noch der Wert aus der
Dokumentation oder einer Beispieldatei. Erzeuge einen eigenen mit
`openssl rand -base64 48`. Bei einer bestehenden Installation sind die
gespeicherten Monitoring-Zugangsdaten danach nicht mehr lesbar; gib sie
anschließend neu ein.

**PostgreSQL: „The public database role ... may create objects in the
schema ...“.**
Die öffentliche Rolle darf im Tabellenschema Objekte anlegen, meist weil
PostgreSQL vor Version 15 (oder ein davon aktualisierter Cluster) allen erlaubt,
im Schema `public` Objekte anzulegen. Die Instanz startet erst, wenn das
entzogen ist: Führe `deploy/postgres/harden.sql` erneut als Superuser in dieser Datenbank aus, wie im
[Sicherheitsmodell](../../security-model.md) beschrieben, oder führe als
Superuser `REVOKE CREATE ON SCHEMA public FROM PUBLIC` aus (liegen die Tabellen in einem anderen Schema, entziehe es dort ebenfalls).

**`docker compose` meldet „set SECRET_KEY in .env“ oder „set
POSTGRES_PASSWORD in .env“.**
Die Variable fehlt in `.env` oder ist leer. Bei einer neuen Installation
hängst du beide mit der `printf`-Zeile aus der
[Installation](02-installation.md#installieren) an. Bei einer bestehenden
Installation holst du die alten Werte aus deiner Sicherung, statt neue zu
erzeugen: Ein neuer `SECRET_KEY` macht gespeicherte Monitoring-Zugangsdaten
unlesbar, und ein neues `POSTGRES_PASSWORD` passt nicht zur bestehenden
Datenbank.

**`docker compose` meldet „no configuration file provided“, „env file
... not found“ oder „set SECRET_KEY in .env“.**
Der Befehl läuft im falschen Verzeichnis, oder `.env` gibt es noch nicht
(ohne sie bricht Compose an der ersten Pflichtvariable ab).
Wechsle in das Verzeichnis mit `compose.yaml` und `.env` (in einem Klon:
`deploy/compose`) und leg `.env` an, wie in der
[Installation](02-installation.md#installieren) beschrieben.

**Ein Wert aus `.env` kommt gekürzt an, oder Compose warnt „The ... variable
is not set“.**
Compose wertet `$` in `.env` aus: Aus `pa$wort` wird `pa`. Setz den ganzen
Wert in einfache Anführungszeichen (`SMTP_PASSWORD='pa$wort'`) und führ
`docker compose up -d` aus.

**Eine Änderung in `.env` wirkt nicht.**
Führ `docker compose up -d` aus; `docker compose restart` behält die alte
Umgebung. `docker compose exec openstatuspage env` zeigt, was im Container
ankommt. `DATABASE_URL` setzt immer `compose.yaml`.

**Nach dem Wechsel auf `compose.yaml` ist die Installation leer.**
Die neue Datei nutzt einen anderen Projektnamen und damit neue Volumes. Siehe
[Umstieg von der Compose-Datei aus 0.1.0](09-operations.md#umstieg-von-der-compose-datei-aus-010).

**„DATABASE_URL must start with sqlite: or postgres://“.**
Verwende `sqlite:/pfad/zur/datei.db` oder
`postgres://benutzer:passwort@host:5432/db`. Sonderzeichen im Passwort
müssen URL-kodiert sein.

**Im Log steht die Warnung „no users exist“.**
Beim ersten Start waren weder `ADMIN_EMAIL`/`ADMIN_PASSWORD` gesetzt, noch
wurde ein Benutzer angelegt. Nutze den Befehl `create-user`, siehe
[Installation](02-installation.md#der-erste-administrator).

## Anmeldung

**Ich habe das Administrator-Passwort vergessen.**
Führe `create-user` mit derselben E-Mail-Adresse aus: Der Befehl setzt für den
bestehenden Benutzer ein neues Passwort und die Rolle, meldet ihn überall ab
und widerruft die API-Tokens, die er angelegt hat.

**Direkt nach der Anmeldung bin ich wieder abgemeldet.**
`BASE_URL` beginnt mit `https://`, die Seite ist aber über `http://`
geöffnet: Das Sitzungs-Cookie wird dann nur über HTTPS gesendet. Öffne die
Seite über die URL aus `BASE_URL`.

**„Too many requests“ auf der Anmeldeseite, und zwar bei allen.**
Hinter einem Reverse Proxy ohne `TRUST_PROXY` teilen sich alle Benutzer die IP
des Proxys und damit ein Rate Limit. Setze `TRUST_PROXY` (siehe
[Reverse Proxy](03-reverse-proxy.md#trust_proxy)).

**SSO scheitert mit einem Fehlercode auf der Anmeldeseite.**
Die Codes (`oidc_unavailable`, `forbidden`, `no_account`,
`email_not_verified`, ...) erklärt [`docs/oidc.md`](../../oidc.md). Die
häufigsten Ursachen: Die Redirect-URI beim Identity Provider stimmt nicht
exakt mit `${BASE_URL}/api/auth/oidc/callback` überein, die Issuer-URL ist vom
Server aus nicht erreichbar, oder im Token fehlt der Gruppen-Claim.

## Monitoring

**Eine Pull-Quelle zeigt einen Fehler.**
Der Fehlertext steht an der Quelle. Typisch: falsche Basis-URL, fehlende
Rechte des API-Benutzers, nicht vertrauenswürdiges TLS-Zertifikat (setze
`NODE_EXTRA_CA_CERTS`, statt die Prüfung abzuschalten), Firewall zwischen
Statusseite und Monitoring-API. „Verbindung testen“ prüft, ohne etwas zu
speichern.

**Gepushte Ergebnisse kommen nicht an.**
Ruf die Ingest-URL von Hand mit `curl` auf und sieh dir die Antwort an: `401`
falsches Token (erneuert?), `404` falsche Quellen-ID, `409` Quelle
deaktiviert oder vollständiger Abgleich abgelehnt, weil er die meisten
verknüpften Checks entfernen würde, `413` Anfrage zu groß für den Reverse
Proxy, `429` mehr als 120 Anfragen pro Minute. Den Grund findest du in
`errors[0].detail` der Antwort (`source.pointer` nennt das Feld einer
ungültigen Nutzlast, z. B. `/checks/0/state`). Starte die
Benachrichtigungsskripte mit `OSP_DRY_RUN=1`, um die gesendeten Daten zu
sehen.

**Ein Service bleibt betriebsbereit, obwohl ein Check kritisch ist.**
Prüfe, ob die Statusquelle des Services *Automatisch* ist, ob der Check
verknüpft ist und worauf die Verknüpfung *Kritisch* abbildet (vielleicht auf
„Ignorieren“). Bei *Redundanz (Quorum)* führt ein einzelner ausgefallener
Check nur zu einem Teilausfall. Während einer laufenden Wartung steht dort
*Wartung*.

**Plötzlich haben alle Pull-Quellen Fehler bei der Anmeldung.**
`SECRET_KEY` wurde geändert. Trag die Zugangsdaten jeder Quelle neu ein,
siehe [Betrieb](09-operations.md#secret_key).

## Öffentliche Seite

**Ein Service, Vorfall oder eine Wartung erscheint nicht.**
Prüfe, ob *Auf der öffentlichen Statusseite sichtbar* gesetzt ist. Services
einer versteckten Gruppe erscheinen ohne Gruppe. Geplante Wartungen werden
nur bis zu ihrem geplanten Ende angezeigt.

**Die Wartung hat nicht automatisch begonnen oder geendet.**
Auf keiner Instanz läuft der Worker (`WORKER_ENABLED=false` überall), oder
*Automatisch starten* / *Automatisch abschließen* sind aus. Der Wechsel
passiert innerhalb von 30 Sekunden nach dem geplanten Zeitpunkt.

**Änderungen erscheinen verzögert.**
Antworten der öffentlichen API dürfen von Browsern und Proxys 30 Sekunden
zwischengespeichert werden.

**Die Seite lässt sich nicht in einen iframe einbetten.**
Dein Proxy setzt `X-Frame-Options` oder eine `frame-ancestors`-Richtlinie.
Siehe [Reverse Proxy](03-reverse-proxy.md#öffentliche-seite-einbetten).

**Links in Feeds oder E-Mails zeigen auf `localhost`.**
`BASE_URL` ist nicht auf die öffentliche URL gesetzt.

## E-Mail

Siehe die Tabelle zur Fehlersuche unter
[E-Mail-Abonnements](07-email-subscriptions.md#fehlersuche).

## Hilfe bekommen

Wenn du ein Problem meldest, gib die Version (Image-Tag, oder den Git-Commit,
wenn du selbst baust), die Art der Installation, die relevanten Log-Zeilen
und die Schritte zum Nachstellen an. Entferne vorher Geheimnisse, Hostnamen
und E-Mail-Adressen.
