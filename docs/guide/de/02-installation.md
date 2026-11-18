# Installation und Deployment

OpenStatusPage läuft als einzelner Node.js-Prozess, der die API, die
öffentliche Seite und die Verwaltung ausliefert. Jedes Release erscheint als
Container-Image für `linux/amd64` und `linux/arm64`:

```text
ghcr.io/raphael-penning/openstatuspage
```

Du hast diese Möglichkeiten:

| Variante | Datenbank | Geeignet für |
| --- | --- | --- |
| [Docker Compose mit dem fertigen Image](#docker-compose-mit-dem-fertigen-image) | PostgreSQL-17-Container | die meisten Produktivumgebungen |
| [Einzelner Container mit SQLite](#einzelner-container-mit-sqlite) | SQLite-Datei in einem Volume | kleine Setups mit einer Instanz |
| [Kubernetes](#kubernetes) | externes PostgreSQL (oder SQLite auf einem Volume) | Cluster mit Ingress-Controller |
| [Image selbst bauen](#image-selbst-bauen) | wie bei Compose | eigene Änderungen, andere Plattformen |
| [Aus dem Quellcode](#aus-dem-quellcode) | SQLite oder PostgreSQL | Hosts ohne Docker, Entwicklung |

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

## Image-Tags

| Tag | Enthält | Wofür |
| --- | --- | --- |
| `1.2.3` | genau dieses Release | Produktivbetrieb (empfohlen) |
| `1.2` | das neueste Patch-Release von 1.2 | Fehlerbehebungen ohne neue Funktionen |
| `1` | das neueste Release der Hauptversion 1 (nicht für 0.x-Versionen) | neue Funktionen ohne Breaking Changes |
| `latest` | das neueste stabile Release | zum Ausprobieren |
| `edge` | den aktuellen Stand des Branches `main` | kommende Änderungen testen, **nicht für den Produktivbetrieb** |
| `sha-<Commit>` | einen Commit des Branches `main` | einer Regression auf die Spur kommen |

Vorabversionen wie `1.3.0-rc.1` bekommen nur ihren eigenen Tag; `latest`,
`1.3` und `1` bleiben davon unberührt. Bis das erste Release erschienen ist,
gibt es nur `edge` und die `sha-`-Tags.

**Leg dich im Produktivbetrieb auf ein Release fest** (`1.2.3`) und update
bewusst, nachdem du die Release Notes gelesen und eine Sicherung gemacht hast
(siehe [Updates](09-operations.md#updates)). Mit `latest` oder einem anderen
mitwandernden Tag kann schon ein Neustart oder `pull` die Datenbank ohne
Vorwarnung migrieren, und
[Migrationen gehen nur vorwärts](09-operations.md#zurückrollen). Am
strengsten pinnst du mit dem Digest des Images statt eines Tags
(`ghcr.io/raphael-penning/openstatuspage@sha256:...`, angezeigt von
`docker buildx imagetools inspect`).

Die Images baut und veröffentlicht die CI-Pipeline des Repositorys, siehe
[`docs/releasing.md`](../../releasing.md).

## Docker Compose mit dem fertigen Image

Im Repository liegt eine einsatzbereite [`docker/docker-compose.yml`](../../../docker/docker-compose.yml)
mit zwei Diensten: `openstatuspage` (das fertige Image) und `db`
(PostgreSQL 17). Die Daten liegen in den benannten Volumes `pg` (Datenbank)
und `data`.

### Compose-Datei holen

Entweder klonst du das Repository:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
```

oder du lädst nur die Compose-Datei herunter, und zwar in ein Verzeichnis
`docker`, damit die Befehle in dieser Anleitung unverändert funktionieren:

```bash
mkdir -p openstatuspage/docker && cd openstatuspage
curl -fsSL -o docker/docker-compose.yml \
  https://raw.githubusercontent.com/Raphael-Penning/openstatuspage/main/docker/docker-compose.yml
```

Willst du die Datei genau so, wie sie zu einem Release gehört, ersetzt du
`main` in der URL durch den Release-Tag (z. B. `v1.2.3`).

### Env-Datei anlegen

Deine Einstellungen kommen in eine vertrauliche Datei `deploy.env` neben dem
Verzeichnis `docker`. Erzeuge die Geheimnisse einmalig:

```bash
touch deploy.env && chmod 600 deploy.env
echo "SECRET_KEY=$(openssl rand -base64 48)" >> deploy.env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> deploy.env
```

Den Rest ergänzt du mit einem Editor:

```bash
# deploy.env (vertraulich: chmod 600, nie committen)
SECRET_KEY=<erzeugt>
POSTGRES_PASSWORD=<erzeugt>
OSP_VERSION=1.2.3
BASE_URL=https://status.example.com
HOST_PORT=127.0.0.1:3000
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ein-langes-passwort
```

| Variable | Bedeutung |
| --- | --- |
| `OSP_VERSION` | [Image-Tag](#image-tags), der laufen soll, Standard `latest`. Leg dich auf ein Release fest. |
| `OSP_IMAGE` | Image ohne Tag, Standard `ghcr.io/raphael-penning/openstatuspage`. Ändere es für einen Fork oder einen eigenen Registry-Mirror. |
| `HOST_PORT` | Port auf dem Host, siehe [HOST_PORT](#host_port). |

Bewahre diese Datei auf: Bei jedem weiteren Befehl brauchst du denselben
`SECRET_KEY` und dasselbe `POSTGRES_PASSWORD`. Git ignoriert sie (wie jede
`*.env`-Datei), und sie gehört nicht zum Docker-Build-Kontext. Sie landet also
weder in einem Commit noch in einem Image.

### Starten

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml pull
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d
```

Fehlt `SECRET_KEY` oder `POSTGRES_PASSWORD`, startet Compose nicht. Compose
liest die Datei bei **jedem** Befehl (`ps`, `logs`, `exec`, ...), übergib
deshalb immer `--env-file deploy.env`, so wie alle Befehle in dieser
Anleitung. Weniger tippen musst du, wenn du in deiner Shell
`COMPOSE_ENV_FILES=deploy.env` und `COMPOSE_FILE=docker/docker-compose.yml`
setzt; dann nutzt auch ein einfaches `docker compose up -d` beides.

Prüfe, ob alles läuft:

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml ps
curl -fsS http://127.0.0.1:3000/api/health
```

Nach ein paar Sekunden zeigt `ps` die Anwendung als `healthy`, und der
Health-Endpunkt liefert `{"status":"ok"}`. Öffne anschließend
`http://localhost:3000/admin` (oder deine `BASE_URL`) und melde dich an. Für
HTTPS geht es mit dem [Reverse Proxy](03-reverse-proxy.md) weiter.

### Weitere Umgebungsvariablen

Die Compose-Datei reicht `BASE_URL`, `SECRET_KEY`, `DATABASE_URL`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` und die E-Mail-Variablen (`MAIL_TRANSPORT`,
`SMTP_*`, siehe [E-Mail-Abonnements](07-email-subscriptions.md#mailserver)) in
den Container durch; diese setzt du also einfach in `deploy.env`. Weitere
Optionen (zum Beispiel `TRUST_PROXY`, `LOG_LEVEL` oder die OIDC-Variablen)
müssen in den Abschnitt `environment:` des Dienstes `openstatuspage`. Das
machst du am besten in einer kleinen eigenen Override-Datei: Dann bleibt die
mitgelieferte Compose-Datei unverändert, und du kannst sie bei Updates
einfach ersetzen.

```yaml
# docker/docker-compose.local.yml
services:
  openstatuspage:
    environment:
      TRUST_PROXY: "1"
      LOG_LEVEL: ${LOG_LEVEL:-info}
```

`${...}` übernimmt den Wert aus `deploy.env`. Die Override-Datei übergibst du
bei jedem Befehl mit einem zweiten `-f`:

```bash
docker compose --env-file deploy.env \
  -f docker/docker-compose.yml -f docker/docker-compose.local.yml up -d
```

### HOST_PORT

Im Container lauscht die Anwendung auf Port 3000. `HOST_PORT` (Standard
`3000`) legt fest, unter welchem Port sie auf dem Host erreichbar ist:

- `HOST_PORT=8080` veröffentlicht Port 8080 auf allen Schnittstellen.
- `HOST_PORT=127.0.0.1:3000` veröffentlicht ihn nur auf localhost. Das ist
  richtig, wenn ein Reverse Proxy auf demselben Host HTTPS übernimmt: Der
  unverschlüsselte Port ist dann von außen nicht erreichbar.

### Optionale Demodaten

Zum Ausprobieren mit fiktiven Daten füllst du eine **leere** Datenbank einmalig:

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml \
  exec openstatuspage node server/dist/cli/seed.js
```

Der Befehl bricht ab, wenn schon Services existieren. Verwende ihn nicht auf
einer produktiven Instanz.

## Einzelner Container mit SQLite

Ohne PostgreSQL legt das Image seine SQLite-Datenbank in `/data` ab
(`DATABASE_URL=sqlite:/data/openstatuspage.db` ist voreingestellt). Binde dort
ein Volume ein, sonst sind die Daten mit dem Container weg.

```bash
cat > openstatuspage.env <<EOF
SECRET_KEY=$(openssl rand -base64 48)
BASE_URL=https://status.example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ein-langes-passwort
EOF
chmod 600 openstatuspage.env

docker run -d --name openstatuspage --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v openstatuspage-data:/data \
  --env-file openstatuspage.env \
  ghcr.io/raphael-penning/openstatuspage:1.2.3
```

Bewahre `openstatuspage.env` auf und nutze sie bei jedem weiteren
`docker run`; ein neuer `SECRET_KEY` macht gespeicherte
Monitoring-Zugangsdaten unlesbar. Für ein Update holst du den neuen Tag mit
`docker pull`, entfernst den Container (`docker rm -f openstatuspage`; das
Volume bleibt) und startest den Befehl erneut mit dem neuen Tag.

Die Compose-Datei funktioniert auch mit SQLite: Entferne den Dienst `db`, den
Block `depends_on`, das Volume `pg` und die Zeile `DATABASE_URL`.

SQLite unterstützt genau eine laufende Instanz. Für
[weitere Instanzen](09-operations.md#mehrere-instanzen-betreiben) brauchst du
PostgreSQL.

## Kubernetes

Im Verzeichnis `deploy/kubernetes/` des Repositorys liegen Beispiel-Manifeste,
die Kustomize zusammenfasst:

| Datei | Inhalt |
| --- | --- |
| `kustomization.yaml` | Namespace `openstatuspage`, Liste der Ressourcen, festgelegter Image-Tag |
| `namespace.yaml` | der Namespace |
| `deployment.yaml` | ein Replikat, Strategie `Recreate`, Health-Probes auf `/api/health`, Security Context ohne Root |
| `service.yaml` | clusterinterner Service für den Pod |
| `ingress.yaml` | Host `status.example.com` mit TLS |
| `pvc.yaml` | Volume für `/data` (nötig für SQLite, mit PostgreSQL unschädlich) |
| `secret.example.yaml` | beschreibt die Schlüssel des Secrets; wird **nicht** angewendet |

Voraussetzungen:

- ein Ingress-Controller (das Beispiel nutzt die Standard-Ingress-Klasse des
  Clusters; andernfalls setzt du `ingressClassName` in `ingress.yaml`),
- optional cert-manager für das TLS-Zertifikat: Ergänze die Annotation aus
  dem Kommentar in `ingress.yaml`. Ohne cert-manager legst du das
  TLS-Secret `openstatuspage-tls` selbst an,
- eine PostgreSQL-Datenbank, z. B. eine verwaltete Datenbank oder ein
  Operator im Cluster. Ohne sie nutzt die Anwendung SQLite auf dem Volume,
  und dann ist genau ein Replikat möglich.

### Namespace und Secret anlegen

Das Secret `openstatuspage` enthält alles Vertrauliche. Leg es direkt mit
`kubectl` an und committe es nie:

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml

kubectl -n openstatuspage create secret generic openstatuspage \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=DATABASE_URL='postgres://openstatuspage:<Passwort>@db.example.com:5432/openstatuspage' \
  --from-literal=ADMIN_EMAIL=admin@example.com \
  --from-literal=ADMIN_PASSWORD='ein-langes-passwort'
```

Optionale Schlüssel: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, `SMTP_FROM` und die übrigen Variablen aus
[Konfiguration](04-configuration.md), z. B. `OIDC_CLIENT_SECRET`. Damit die
Werte nicht in deiner Shell-History landen, schreibst du sie in eine
vertrauliche Datei und nimmst `--from-env-file=openstatuspage.env` statt
`--from-literal`. Sichere `SECRET_KEY` außerhalb des Clusters; auslesen
kannst du ihn mit
`kubectl -n openstatuspage get secret openstatuspage -o jsonpath='{.data.SECRET_KEY}' | base64 -d`.

### Manifeste anpassen und anwenden

1. Trag deinen Hostnamen in `ingress.yaml` ein (Regel und TLS-Abschnitt) und
   dieselbe URL als `BASE_URL` in `deployment.yaml`.
2. Prüfe `TRUST_PROXY` in `deployment.yaml`: Der Wert muss der Anzahl der
   Proxys vor der Anwendung entsprechen, siehe
   [Reverse Proxy](03-reverse-proxy.md#kubernetes-ingress).
3. Leg den Image-Tag in `kustomization.yaml` fest:

   ```yaml
   images:
     - name: ghcr.io/raphael-penning/openstatuspage
       newTag: "1.2.3"
   ```

4. Anwenden und auf den Rollout warten:

   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl -n openstatuspage rollout status deployment/openstatuspage
   ```

Statt die Dateien zu bearbeiten, kannst du sie unverändert lassen und ein
eigenes Kustomize-Overlay schreiben: eine `kustomization.yaml`, die das
Verzeichnis (oder eine Kopie davon) unter `resources:` einbindet und Host,
`BASE_URL` und Tag mit `patches:` und `images:` ändert. So bleiben deine
Änderungen getrennt, wenn du neuere Manifeste übernimmst.

Installation prüfen:

```bash
kubectl -n openstatuspage get pods
kubectl -n openstatuspage logs deployment/openstatuspage
kubectl -n openstatuspage port-forward deployment/openstatuspage 3000:3000
# in einem zweiten Terminal:
curl -fsS http://127.0.0.1:3000/api/health
```

Öffne anschließend `https://status.example.com/admin` und melde dich an.

Bleib bei **einem Replikat**, solange die Regeln aus
[Mehrere Instanzen betreiben](09-operations.md#mehrere-instanzen-betreiben)
nicht erfüllt sind: PostgreSQL, und der Worker läuft auf genau einem Pod. Die
Strategie `Recreate` sorgt dafür, dass bei einem Update nie zwei Versionen
gleichzeitig mit derselben Datenbank arbeiten.

Die Befehle `create-user` und `seed` laufen im Pod genauso wie bei Docker,
z. B. `kubectl -n openstatuspage exec deployment/openstatuspage -- node server/dist/cli/create-user.js ...`.

## Image selbst bauen

Bau das Image aus dem Repository, wenn du den Code geändert hast oder eine
andere Plattform als `linux/amd64` und `linux/arm64` brauchst. Die
Override-Datei [`docker/docker-compose.build.yml`](../../../docker/docker-compose.build.yml)
ergänzt den Build-Abschnitt und nennt das Image `openstatuspage:local`:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
docker compose --env-file deploy.env \
  -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build
```

Nutze beide `-f`-Dateien bei jedem weiteren Befehl und führe nach jedem
`git pull` erneut `up -d --build` aus. Ohne Compose baust du mit
`docker build -f docker/Dockerfile -t openstatuspage:local .`

## Aus dem Quellcode

Voraussetzungen: Node.js 22 oder neuer und pnpm 10 (`corepack enable`
installiert die in `package.json` festgelegte pnpm-Version). Für die nativen
Module (SQLite, Passwort-Hashing) brauchst du eventuell `python3`, `make` und
einen C++-Compiler, falls es für deine Plattform kein fertiges Binary gibt.

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git /opt/openstatuspage
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
   `ADMIN_PASSWORD` nach der ersten Anmeldung aus der Umgebung (`deploy.env`
   oder dem Kubernetes-Secret) und ändere das Passwort im Benutzermenü.
2. **Der Befehl `create-user`** legt einen Benutzer an oder setzt, wenn die
   Adresse schon existiert, ein neues Passwort und die Rolle und beendet die
   Sitzungen des Benutzers:

   ```bash
   # Docker Compose
   docker compose --env-file deploy.env -f docker/docker-compose.yml exec openstatuspage \
     node server/dist/cli/create-user.js admin@example.com 'ein-langes-passwort' admin 'Erika Mustermann'

   # einzelner Container
   docker exec openstatuspage node server/dist/cli/create-user.js admin@example.com 'ein-langes-passwort' admin

   # Kubernetes
   kubectl -n openstatuspage exec deployment/openstatuspage -- \
     node server/dist/cli/create-user.js admin@example.com 'ein-langes-passwort' admin

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
  Endpunkt für seinen eingebauten Health-Check (`docker ps` zeigt `healthy`),
  das Kubernetes-Beispiel für seine Readiness- und Liveness-Probes.
- Konfigurationsfehler stehen mit den betroffenen Variablen im Log; bei
  ungültiger Konfiguration beendet sich der Prozess.
- Melde dich unter `/admin` an, öffne **Einstellungen** und gib der Seite
  einen Namen.

Lässt sich das Image nicht herunterladen, hilft die
[Fehlerbehebung](10-troubleshooting.md#container-image).

Weiter geht es mit dem [Reverse Proxy und HTTPS](03-reverse-proxy.md).
