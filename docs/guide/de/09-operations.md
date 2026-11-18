# Betrieb

Diese Seite behandelt Sicherungen, Updates, Health-Checks, Logs und den
Umgang mit `SECRET_KEY`. Die Befehle gehen vom Docker-Compose-Setup aus der
[Installation](02-installation.md) mit den Einstellungen in `deploy.env` aus;
passe Dienst- und Volume-Namen an deine Umgebung an. Nutzt du
Override-Dateien (z. B. für Caddy), ergänzt du ihre `-f`-Optionen bei jedem
Befehl.

## Sicherung und Wiederherstellung

### Was du sichern musst

1. **Die Datenbank**: PostgreSQL-Datenbank oder SQLite-Datei. Darin steckt
   alles: Services, Vorfälle, Verlauf, Benutzer, Einstellungen, Abonnenten.
2. **`SECRET_KEY`** (und den Rest deiner Env-Datei). Ohne denselben Schlüssel
   kann eine wiederhergestellte Datenbank die gespeicherten
   Monitoring-Zugangsdaten nicht entschlüsseln. Bewahre ihn getrennt von der
   Datenbanksicherung auf, z. B. in deinem Passwortmanager.
3. Deine eigenen Änderungen an der Compose-Datei oder der Proxy-Konfiguration.

Sichere mindestens täglich und vor jedem Update, bewahre mehrere Generationen
auf, lagere Kopien außerhalb des Hosts und teste ab und zu eine
Wiederherstellung.

### PostgreSQL

Sicherung (Custom-Format, komprimiert):

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml exec -T db \
  pg_dump -U openstatuspage -Fc openstatuspage > openstatuspage-$(date +%F).dump
```

Wiederherstellung:

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml stop openstatuspage
docker compose --env-file deploy.env -f docker/docker-compose.yml exec -T db \
  pg_restore -U openstatuspage -d openstatuspage --clean --if-exists < openstatuspage-2026-01-31.dump
docker compose --env-file deploy.env -f docker/docker-compose.yml start openstatuspage
```

Bei einem externen PostgreSQL-Server (und unter Kubernetes) nutzt du
`pg_dump` / `pg_restore` genauso mit den Zugangsdaten aus `DATABASE_URL`.
Stoppe die Anwendung vor einer Wiederherstellung mit
`kubectl -n openstatuspage scale deployment/openstatuspage --replicas=0` und
starte sie danach wieder mit `--replicas=1`.

### SQLite

SQLite läuft im WAL-Modus: Zur Datenbank gehören neben `openstatuspage.db`
die Dateien `-wal` und `-shm`. Kopiere bei laufender Instanz nicht einfach die
`.db`-Datei, sondern nutze eines dieser Verfahren.

**Online-Sicherung** über die Backup-API von SQLite (konsistent, während die
Anwendung läuft). Im Docker-Image:

```bash
docker exec -w /app/server openstatuspage node -e "
  const db = require('better-sqlite3')('/data/openstatuspage.db', { readonly: true });
  db.backup('/data/backup.db').then(() => { db.close(); console.log('backup written'); });
"
docker cp openstatuspage:/data/backup.db ./openstatuspage-$(date +%F).db
docker exec openstatuspage rm /data/backup.db
```

Ersetze `openstatuspage` durch den Namen des Containers (`docker ps` zeigt
ihn; mit Compose nimmst du
`docker compose --env-file deploy.env -f docker/docker-compose.yml exec -w /app/server openstatuspage ...`).
Auf einem Host mit dem Kommandozeilenwerkzeug `sqlite3` geht stattdessen
`sqlite3 /var/lib/openstatuspage/openstatuspage.db ".backup '/backup/openstatuspage.db'"`.

**Offline-Sicherung**: Anwendung stoppen, das ganze Volume kopieren, wieder
starten:

```bash
docker stop openstatuspage
docker run --rm -v openstatuspage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/openstatuspage-data-$(date +%F).tar.gz -C /data .
docker start openstatuspage
```

**Wiederherstellung**: Anwendung stoppen, Datenbankdatei ersetzen, veraltete
`-wal`- und `-shm`-Dateien entfernen, Anwendung starten:

```bash
docker stop openstatuspage
docker run --rm -v openstatuspage-data:/data -v "$PWD":/backup alpine sh -c \
  "rm -f /data/openstatuspage.db-wal /data/openstatuspage.db-shm && \
   cp /backup/openstatuspage-2026-01-31.db /data/openstatuspage.db && \
   chown 1000:1000 /data/openstatuspage.db"
docker start openstatuspage
```

Im Container läuft die Anwendung als Benutzer `node` (UID 1000) und braucht
Schreibrechte auf die Datei. Von Compose angelegte Volumes tragen den
Projektnamen als Präfix (z. B. `docker_data`); `docker volume ls` zeigt den
genauen Namen.

## Updates

Jedes Update läuft in denselben Schritten ab:

1. Lies die Release Notes auf Breaking Changes, auch die der Versionen, die
   du überspringst.
2. Erstelle eine Sicherung (siehe oben).
3. Wechsle auf die neue Version (siehe unten).
4. Datenbankmigrationen laufen beim Start **automatisch**. Achte im Log auf
   Fehler und prüfe `/api/health`.

### Docker Compose

Trag das neue Release in `deploy.env` ein, hol das Image und erstelle den
Container neu:

```bash
# deploy.env
OSP_VERSION=1.3.0
```

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml pull
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d
```

Folgst du einem mitwandernden Tag (`1.3`, `latest`), holen und starten `pull`
und `up -d` allein das neueste Image dieses Tags. Erwähnen die Release Notes
Änderungen an `docker/docker-compose.yml`, ersetzt du deine Kopie durch die
Datei des neuen Releases (`git pull` oder erneut herunterladen, siehe
[Installation](02-installation.md#compose-datei-holen)). Deine eigenen
Einstellungen bleiben in `deploy.env` und deinen Override-Dateien unberührt.

Alte Images räumst du danach mit `docker image prune` weg.

### Einzelner Container

```bash
docker pull ghcr.io/raphael-penning/openstatuspage:1.3.0
docker rm -f openstatuspage
docker run -d --name openstatuspage ... ghcr.io/raphael-penning/openstatuspage:1.3.0
```

Verwende dieselben Optionen wie bei der Installation; die Daten bleiben im
Volume.

### Kubernetes

Ändere `newTag` in `kustomization.yaml`, wende die Manifeste an und warte auf
den Rollout:

```bash
kubectl apply -k deploy/kubernetes
kubectl -n openstatuspage rollout status deployment/openstatuspage
```

Die Strategie `Recreate` stoppt den alten Pod, bevor der neue startet. So
laufen die Migrationen nie, während die alte Version noch aktiv ist.

### Selbst gebaut und aus dem Quellcode

Mit der Build-Override-Datei:

```bash
git pull
docker compose --env-file deploy.env \
  -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build
```

Aus dem Quellcode: `git pull && pnpm install --frozen-lockfile && pnpm build`,
dann den Dienst neu starten. `pnpm db:migrate` wendet Migrationen an, ohne den
Server zu starten, z. B. um ein Update an einer Kopie der Datenbank zu testen.

### Zurückrollen

Migrationen gehen nur vorwärts; eine ältere Version läuft nicht mit einer
Datenbank, die eine neuere Version migriert hat. So rollst du ein Update
zurück:

1. Stoppe die Anwendung.
2. Spiel die Sicherung von vor dem Update zurück.
3. Starte wieder die **vorherige** Version: das alte `OSP_VERSION` in
   `deploy.env`, den alten `newTag` in `kustomization.yaml` oder den
   vorherigen Git-Tag, wenn du selbst baust.

Was seit dem Update geändert wurde, geht dabei verloren, also entscheide
schnell.

## Health-Check

`GET /api/health` liefert `200 {"status":"ok"}`, wenn die Anwendung läuft und
die Datenbank antwortet, sonst einen Fehlerstatus. Eine Anmeldung ist nicht
nötig.

- Das Docker-Image hat einen eingebauten `HEALTHCHECK`, der den Endpunkt alle
  30 Sekunden aufruft.
- Das Kubernetes-Beispiel nutzt ihn für die Readiness- und Liveness-Probes.
- Nutze ihn für Health-Checks von Load Balancern und Container-Orchestrierung.

## Die Statusseite überwachen

Eine Statusseite wird gerade dann gebraucht, wenn deine Infrastruktur Probleme
hat. Überwache sie deshalb **von außerhalb** dieser Infrastruktur: mit einem
externen Monitoring-Dienst oder einer Monitoring-Instanz in einem anderen Netz
oder bei einem anderen Anbieter. Überwachst du sie nur mit demselben Icinga
oder Uptime Kuma, das sie speist, erfährst du nichts, wenn das gemeinsame Netz
ausfällt.

Empfohlene Checks:

- `https://status.example.com/api/health`: HTTP 200 (Anwendung und
  Datenbank).
- `https://status.example.com/`: HTTP 200 (die Seite, wie Kunden sie sehen,
  einschließlich Proxy und Zertifikat).
- Das Ablaufdatum des TLS-Zertifikats.
- Bei Push-Anbindungen: Die Quellenliste in der Verwaltung zeigt, wann
  zuletzt Daten ankamen. Bleibt eine Quelle stumm, steckt meist ein kaputtes
  Benachrichtigungsskript oder eine Firewall-Regel dahinter.
- Mit E-Mail-Abonnements: die Zahl der fehlgeschlagenen E-Mails unter
  **Warteschlange** im Kasten **E-Mail-Versand** auf der Einstellungsseite.

Achte außerdem darauf, dass die Statusseite nicht mehr als nötig von der
Infrastruktur abhängt, über die sie berichtet (derselbe Host, derselbe
Datenbank-Cluster, dasselbe DNS).

## Logs

Die Anwendung schreibt strukturierte JSON-Logs (ein Objekt pro Zeile) nach
stdout; mit `NODE_ENV=development` sind sie für Menschen formatiert.

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml logs -f openstatuspage
kubectl -n openstatuspage logs -f deployment/openstatuspage   # Kubernetes
journalctl -u openstatuspage -f                                # systemd
```

`LOG_LEVEL` (Standard `info`) bestimmt den Detailgrad: `fatal`, `error`,
`warn`, `info`, `debug`, `trace` oder `silent`. `debug` hilft bei Problemen mit
Monitoring-Adaptern und OIDC; stell danach wieder zurück. `Authorization`- und
`Cookie`-Header werden nie geloggt, und Anfragen an Routen mit Tokens in der
URL (Ingest, Links aus E-Mails) werden erst ab Level `warn` protokolliert.

## Mehrere Instanzen betreiben

Für die meisten Setups reicht eine Instanz. Betreibst du mehrere (z. B. für
Hochverfügbarkeit):

- Nutze **PostgreSQL**. SQLite lässt sich nicht zwischen Instanzen teilen.
- Setze `WORKER_ENABLED=false` auf allen Instanzen außer **einer**. Der Worker
  übernimmt Monitoring-Abfragen, automatischen Start und Abschluss von
  Wartungen, E-Mail-Versand, Erinnerungen und Aufräumarbeiten; liefe er auf
  mehreren Instanzen, würde alles doppelt erledigt.
- Verwende auf allen Instanzen denselben `SECRET_KEY` und dieselbe
  `BASE_URL`.
- Rate Limits zählen pro Instanz.

Fällt die Worker-Instanz aus, funktionieren Seite und Verwaltung weiter, aber
Abfragen, automatische Wartungswechsel und E-Mails pausieren, bis sie wieder
läuft.

Das gilt genauso für **Kubernetes-Replikate**. Das Beispiel-Deployment läuft
mit einem Replikat, und alle Pods eines Deployments teilen sich dieselbe
Umgebung. Erhöhe also nicht einfach `replicas`. Lass dieses Deployment
stattdessen mit einem Replikat als Worker laufen und betreib die weiteren
Pods in einem zweiten Deployment mit `WORKER_ENABLED=false` (mit eigenem
Selector und einem Service-Selector, der die Pods beider erfasst). Die
zusätzlichen Pods brauchen mit PostgreSQL kein `/data`-Volume; das
Beispiel-Volume ist `ReadWriteOnce` und lässt sich nur auf einem Node
einbinden.

## SECRET_KEY

`SECRET_KEY` (mindestens 32 Zeichen, erzeugen mit `openssl rand -base64 48`)
dient dazu,

- die Zugangsdaten von Monitoring-Quellen zu verschlüsseln (AES-256-GCM),
- das kurzlebige Cookie mit dem Anmeldestatus beim Single Sign-On zu
  signieren,
- die Tokens in den Bestätigungs-, Verwaltungs- und Abmeldelinks der E-Mails
  an Abonnenten abzuleiten.

Committe ihn nie, halte ihn aus Screenshots und Tickets heraus und sichere ihn
getrennt von der Datenbank.

**Ein Wechsel** hat diese Folgen:

- Gespeicherte Monitoring-Zugangsdaten lassen sich nicht mehr entschlüsseln:
  Trag Passwort oder API-Schlüssel jeder Pull-Quelle neu ein.
- Links in E-Mails, die vor dem Wechsel verschickt wurden, funktionieren nicht
  mehr (Bestätigung, Verwaltung, Abmeldung). Abonnenten können sich mit
  derselben Adresse erneut anmelden und bekommen so einen neuen Link zur
  Verwaltung.
- Gerade laufende Single-Sign-On-Anmeldungen schlagen fehl und müssen neu
  gestartet werden.

Nicht betroffen sind Sitzungen, Benutzerpasswörter, API-Tokens und
Ingest-Tokens (sie werden unabhängig vom Schlüssel als Hash gespeichert).

Wechsle ihn also nur, wenn er bekannt geworden sein könnte, und dann bewusst:
neuen Schlüssel setzen, neu starten, Monitoring-Zugangsdaten neu eintragen.

## Automatisches Aufräumen

Der Worker entfernt von selbst:

- abgelaufene Sitzungen (stündlich),
- unbestätigte E-Mail-Abonnements 7 Tage nach der letzten
  Bestätigungs-E-Mail (stündlich),
- versendete und fehlgeschlagene E-Mails aus der Warteschlange nach 30 Tagen
  (stündlich).

Vorfälle, Wartungen, die Statushistorie und das Audit-Log bleiben erhalten.
