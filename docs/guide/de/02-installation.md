# Installation

OpenStatusPage läuft als einzelner Node.js-Prozess, der die API, die
öffentliche Seite und die Verwaltung ausliefert. Du hast drei Möglichkeiten:

| Variante | Datenbank | Geeignet für |
| --- | --- | --- |
| [Docker Compose mit PostgreSQL](#docker-compose-mit-postgresql) | PostgreSQL-17-Container | die meisten Produktivumgebungen |
| [Einzelner Container mit SQLite](#einzelner-container-mit-sqlite) | SQLite-Datei in einem Volume | kleine Setups mit einer Instanz |
| [Aus dem Quellcode](#aus-dem-quellcode) | SQLite oder PostgreSQL | Hosts ohne Docker, Entwicklung |

Alle Varianten bauen aus dem Quellcode dieses Repositorys; ein fertiges Image
zum Herunterladen gibt es nicht.

## Minimale Konfiguration

Jede Installation braucht mindestens diese Umgebungsvariablen:

| Variable | Beispiel | Wozu |
| --- | --- | --- |
| `SECRET_KEY` | Ausgabe von `openssl rand -base64 48` | Verschlüsselt Monitoring-Zugangsdaten und signiert Daten. Mindestens 32 Zeichen, im Produktivbetrieb Pflicht. **Sichere ihn**, siehe [Betrieb](09-operations.md#secret_key). |
| `BASE_URL` | `https://status.example.com` | Die öffentliche URL für Links in Feeds und E-Mails, die OIDC-Redirect-URI und die Ingest-URLs in der Oberfläche. Ohne abschließenden Schrägstrich. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@example.com`, mindestens 10 Zeichen | Legt den ersten Administrator an, aber nur, solange die Datenbank noch keinen Benutzer enthält. |

`DATABASE_URL` zeigt standardmäßig auf eine SQLite-Datei; für PostgreSQL setzt
du sie selbst. Alle weiteren Optionen beschreibt
[Konfiguration](04-configuration.md).

## Docker Compose mit PostgreSQL

Im Repository liegt eine einsatzbereite [`docker/docker-compose.yml`](../../../docker/docker-compose.yml)
mit zwei Diensten: `openstatuspage` (aus dem Repository gebaut) und `db`
(PostgreSQL 17). Die Daten liegen in den benannten Volumes `pg` (Datenbank)
und `data`.

```bash
git clone <Repository-URL> openstatuspage
cd openstatuspage

export SECRET_KEY="$(openssl rand -base64 48)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export BASE_URL=https://status.example.com
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='ein-langes-passwort'

docker compose -f docker/docker-compose.yml up -d --build
```

Fehlt `SECRET_KEY` oder `POSTGRES_PASSWORD`, startet Compose nicht. Statt die
Variablen zu exportieren, kannst du sie in eine Datei schreiben und mit
`--env-file` übergeben:

```bash
# deploy.env (vertraulich behandeln, z. B. chmod 600)
SECRET_KEY=...
POSTGRES_PASSWORD=...
BASE_URL=https://status.example.com
HOST_PORT=127.0.0.1:3000
```

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d --build
```

Bewahre diese Datei auf: Bei jedem weiteren `up` brauchst du denselben
`SECRET_KEY` und dasselbe `POSTGRES_PASSWORD`.

Die Compose-Datei reicht `BASE_URL`, `SECRET_KEY`, `DATABASE_URL`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` und die E-Mail-Variablen (`MAIL_TRANSPORT`,
`SMTP_*`, siehe [E-Mail-Abonnements](07-email-subscriptions.md#mailserver)) in
den Container durch; diese setzt du also einfach in der Env-Datei oder in der
Shell. Weitere Optionen (zum Beispiel `TRUST_PROXY`, `LOG_LEVEL` oder die
OIDC-Variablen) trägst du im Abschnitt `environment:` des Dienstes
`openstatuspage` ein.

### HOST_PORT

Im Container lauscht die Anwendung auf Port 3000. `HOST_PORT` (Standard
`3000`) legt fest, unter welchem Port sie auf dem Host erreichbar ist:

- `HOST_PORT=8080` veröffentlicht Port 8080 auf allen Schnittstellen.
- `HOST_PORT=127.0.0.1:3000` veröffentlicht ihn nur auf localhost. Das ist
  richtig, wenn ein Reverse Proxy auf demselben Host HTTPS übernimmt: Der
  unverschlüsselte Port ist dann von außen nicht erreichbar.

Öffne anschließend `http://localhost:3000/admin` (oder deine `BASE_URL`) und
melde dich an.

### Optionale Demodaten

Zum Ausprobieren mit fiktiven Daten füllst du eine **leere** Datenbank einmalig:

```bash
docker compose -f docker/docker-compose.yml exec openstatuspage node server/dist/cli/seed.js
```

Der Befehl bricht ab, wenn schon Services existieren. Verwende ihn nicht auf
einer produktiven Instanz.

## Einzelner Container mit SQLite

Ohne PostgreSQL legt das Image seine SQLite-Datenbank in `/data` ab
(`DATABASE_URL=sqlite:/data/openstatuspage.db` ist voreingestellt). Binde dort
ein Volume ein, sonst sind die Daten mit dem Container weg.

```bash
docker build -f docker/Dockerfile -t openstatuspage .

docker run -d --name openstatuspage --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v openstatuspage-data:/data \
  -e SECRET_KEY="$(openssl rand -base64 48)" \
  -e BASE_URL=https://status.example.com \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD='ein-langes-passwort' \
  openstatuspage
```

Bewahre den erzeugten `SECRET_KEY` sicher auf (etwa in einer Env-Datei, die
du mit `--env-file` übergibst). Ein neuer Schlüssel beim nächsten
`docker run` macht gespeicherte Monitoring-Zugangsdaten unlesbar.

Die Compose-Datei funktioniert auch mit SQLite: Entferne den Dienst `db`, den
Block `depends_on`, das Volume `pg` und die Zeile `DATABASE_URL`.

SQLite unterstützt genau eine laufende Instanz. Für
[weitere Instanzen](09-operations.md#mehrere-instanzen-betreiben) brauchst du
PostgreSQL.

## Aus dem Quellcode

Voraussetzungen: Node.js 22 oder neuer und pnpm 10 (`corepack enable`
installiert die in `package.json` festgelegte pnpm-Version). Für die nativen
Module (SQLite, Passwort-Hashing) brauchst du eventuell `python3`, `make` und
einen C++-Compiler, falls es für deine Plattform kein fertiges Binary gibt.

```bash
git clone <Repository-URL> /opt/openstatuspage
cd /opt/openstatuspage
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Lege `/opt/openstatuspage/.env` an (Vorlage: [`.env.example`](../../../.env.example)):

```bash
NODE_ENV=production
BASE_URL=https://status.example.com
SECRET_KEY=<Ausgabe von openssl rand -base64 48>
DATABASE_URL=sqlite:/var/lib/openstatuspage/openstatuspage.db
# oder: DATABASE_URL=postgres://openstatuspage:<Passwort>@localhost:5432/openstatuspage
HOST=127.0.0.1
```

Gestartet wird mit `pnpm start`. Der Server läuft in `apps/server`; er liest
`.env` aus dem Arbeitsverzeichnis oder dem Wurzelverzeichnis des Repositorys
(oder die Datei aus `ENV_FILE`). Verwende einen absoluten SQLite-Pfad: Der
Standard `sqlite:./data/openstatuspage.db` ist relativ zum
Arbeitsverzeichnis.

Eine systemd-Unit kann so aussehen:

```ini
# /etc/systemd/system/openstatuspage.service
[Unit]
Description=OpenStatusPage
After=network-online.target
Wants=network-online.target

[Service]
User=openstatuspage
WorkingDirectory=/opt/openstatuspage/apps/server
EnvironmentFile=/opt/openstatuspage/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Der Benutzer braucht Schreibrechte im Verzeichnis der SQLite-Datei.

Für die lokale Entwicklung (`pnpm dev`, Hot Reload, Vite-Dev-Server auf Port
5173) siehe [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## Der erste Administrator

Für das erste Konto gibt es zwei Wege:

1. **`ADMIN_EMAIL` und `ADMIN_PASSWORD`**: Enthält die Datenbank beim Start
   noch keinen Benutzer, wird ein Administrator mit diesen Daten angelegt.
   Bei späteren Starts werden die Variablen ignoriert. Entferne
   `ADMIN_PASSWORD` nach der ersten Anmeldung aus der Umgebung und ändere das
   Passwort im Benutzermenü.
2. **Der Befehl `create-user`** legt einen Benutzer an oder setzt, wenn die
   Adresse schon existiert, ein neues Passwort und die Rolle:

   ```bash
   # Docker Compose
   docker compose -f docker/docker-compose.yml exec openstatuspage \
     node server/dist/cli/create-user.js admin@example.com 'ein-langes-passwort' admin 'Erika Mustermann'

   # einzelner Container
   docker exec openstatuspage node server/dist/cli/create-user.js admin@example.com 'ein-langes-passwort' admin

   # aus dem Quellcode
   pnpm --filter @openstatuspage/server create-user admin@example.com 'ein-langes-passwort' admin
   ```

   Argumente: E-Mail, Passwort (mindestens 10 Zeichen), Rolle `admin` oder
   `editor` (Standard `admin`) und optional ein Anzeigename. So kommst du
   auch wieder hinein, wenn alle Administratoren ihr Passwort vergessen haben.

Gibt es keinen Benutzer und wurde keiner der beiden Wege genutzt, schreibt der
Server bei jedem Start eine Warnung ins Log.

## Installation prüfen

- `curl -fsS http://127.0.0.1:3000/api/health` liefert `{"status":"ok"}`, wenn
  Anwendung und Datenbank funktionieren. Das Docker-Image nutzt denselben
  Endpunkt für seinen eingebauten Health-Check (`docker ps` zeigt `healthy`).
- Konfigurationsfehler stehen mit den betroffenen Variablen im Log; bei
  ungültiger Konfiguration beendet sich der Prozess.
- Melde dich unter `/admin` an, öffne **Einstellungen** und gib der Seite
  einen Namen.

Weiter geht es mit dem [Reverse Proxy und HTTPS](03-reverse-proxy.md).
