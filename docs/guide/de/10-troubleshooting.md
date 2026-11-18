# Fehlerbehebung

Fang mit den Logs an (`docker compose --env-file deploy.env -f docker/docker-compose.yml logs -f openstatuspage`,
unter Kubernetes `kubectl -n openstatuspage logs deployment/openstatuspage`)
und mit `GET /api/health`. Für mehr Details setzt du vorübergehend
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

**`docker compose` meldet „set SECRET_KEY“ oder „set POSTGRES_PASSWORD“.**
Die Variablen fehlen in der Shell oder in der `--env-file`, die du verwendet
hast. Compose braucht sie bei jedem Befehl (`up`, `pull`, `logs`, `exec`,
...), nicht nur beim ersten `up`: Übergib immer `--env-file deploy.env`.

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
bestehenden Benutzer ein neues Passwort und die Rolle und meldet ihn überall ab.

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
Proxy, `429` mehr als 120 Anfragen pro Minute. Starte die
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
