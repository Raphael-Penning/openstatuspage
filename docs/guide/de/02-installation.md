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
| [Docker Compose](#docker-compose) | PostgreSQL-17-Container | die meisten Produktivumgebungen |
| [Geteilte Installation](#geteilte-installation) | PostgreSQL-17-Container | öffentliche Seite und Admin-Bereich auf getrennten Domains, Worker in eigenem Container |
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

## Docker Compose

Empfohlen ist ein Verzeichnis mit zwei Dateien, das die Anwendung und eine
PostgreSQL-17-Datenbank betreibt. Beide Dateien hängen an jedem
[Release](https://github.com/Raphael-Penning/openstatuspage/releases):

| Datei | Inhalt |
| --- | --- |
| `compose.yaml` | Die Dienste `openstatuspage` (das fertige Image) und `db` (PostgreSQL 17, auf dem Host nicht veröffentlicht). Du musst sie nicht anpassen. |
| `.env` | Deine Einstellungen und Geheimnisse, angelegt aus der Vorlage `env.example`. Jede Variable darin kommt in der Anwendung an. |

Ein Reverse Proxy ist nicht dabei: Die Anwendung veröffentlicht reines HTTP
auf Port 3000, und du stellst deinen eigenen Proxy mit HTTPS davor, siehe
[Reverse Proxy](03-reverse-proxy.md).

### Installieren

Du brauchst Docker mit dem Compose-Plugin (`docker compose version` zeigt
es an). Auf dem Host führst du aus:

```bash
mkdir openstatuspage && cd openstatuspage
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/env.example
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
chmod 600 .env
# edit .env: BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (and HOST_PORT / TRUST_PROXY for your proxy)
docker compose up -d
```

Was die Schritte tun:

1. Das neue Verzeichnis enthält deine Installation; sein Name spielt keine
   Rolle. Die Compose-Datei legt den Projektnamen `openstatuspage` fest,
   deshalb heißen die Volumes immer `openstatuspage_data` und
   `openstatuspage_pg`.
2. Die beiden Downloads stammen aus dem neuesten stabilen Release. Dessen
   `compose.yaml` und `env.example` sind auf dieses Release festgelegt
   (`OSP_VERSION=1.2.3`), die Installation wechselt also nicht von selbst die
   Version.
3. `printf` hängt zwei zufällige Geheimnisse an `.env` an: `SECRET_KEY` und
   das Datenbankpasswort `POSTGRES_PASSWORD`. Führ das nur einmal aus und
   **bewahre eine Kopie beider Werte auf**, siehe
   [SECRET_KEY](09-operations.md#secret_key).
4. `chmod 600` macht `.env` nur für dich lesbar.
5. Nachdem du `.env` bearbeitet hast (siehe unten), holt
   `docker compose up -d` die Images, startet die Datenbank, wartet, bis sie
   bereit ist, und startet die Anwendung. Datenbankmigrationen laufen
   automatisch.

### Einstellungen in .env

Die Vorlage ist gruppiert und kommentiert. Setze mindestens:

```bash
BASE_URL=https://status.example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ein-langes-passwort
```

| Variable | Bedeutung |
| --- | --- |
| `BASE_URL` | Die öffentliche URL, wie [oben](#minimale-konfiguration) beschrieben. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Der [erste Administrator](#der-erste-administrator); wird nur angelegt, solange die Datenbank keinen Benutzer enthält. |
| `HOST_PORT` | Port auf dem Host, Standard `3000`, siehe [HOST_PORT](#host_port). |
| `TRUST_PROXY` | Anzahl der Reverse Proxys vor der Anwendung, `1` in der Vorlage. Ohne Proxy lässt du den Wert leer, siehe [TRUST_PROXY](03-reverse-proxy.md#trust_proxy). |
| `OSP_VERSION` | [Image-Tag](#image-tags), der laufen soll. Leg dich auf ein Release fest. |
| `OSP_IMAGE` | Image ohne Tag, Standard `ghcr.io/raphael-penning/openstatuspage`. Ändere es für einen Fork oder einen eigenen Registry-Mirror. |
| `SECRET_KEY`, `POSTGRES_PASSWORD` | Erzeugt vom Installationsbefehl. Ändere sie später nicht: Ein neuer `SECRET_KEY` macht gespeicherte Monitoring-Zugangsdaten unlesbar, und `POSTGRES_PASSWORD` wirkt nur beim Anlegen der Datenbank. |

Jede weitere Option aus [Konfiguration](04-configuration.md), zum Beispiel
der [Mailserver](07-email-subscriptions.md#mailserver), Single Sign-on oder
`LOG_LEVEL`, kommt ebenfalls in `.env`: `compose.yaml` reicht die ganze Datei
an die Anwendung weiter. Nur `DATABASE_URL` setzt `compose.yaml` selbst (sie
zeigt auf den Dienst `db`), und dieser Wert gewinnt gegen einen Eintrag in
`.env`.

Hinweise zum Dateiformat:

- Eine Zeile `NAME=wert` pro Variable, `#` leitet einen Kommentar ein. Leere
  Werte (`LOG_LEVEL=`) gelten als nicht gesetzt.
- Compose wertet `$` in Werten aus. Vermeide es, oder setz den ganzen Wert in
  einfache Anführungszeichen: `SMTP_PASSWORD='pa$$wort'`.
- Nach einer Änderung führst du `docker compose up -d` aus: Compose erstellt
  den Container mit den neuen Einstellungen neu. `docker compose restart`
  liest `.env` **nicht** neu ein.

Git ignoriert `.env`-Dateien, und sie gehören nicht zum Docker-Build-Kontext.
Die Datei landet also weder in einem Commit noch in einem Image.

### HOST_PORT

Im Container lauscht die Anwendung auf Port 3000. `HOST_PORT` (Standard
`3000`) legt fest, unter welchem Port sie auf dem Host erreichbar ist:

- `HOST_PORT=8080` veröffentlicht Port 8080 auf allen Schnittstellen.
- `HOST_PORT=127.0.0.1:3000` veröffentlicht ihn nur auf localhost. Das ist
  richtig, wenn ein Reverse Proxy auf demselben Host HTTPS übernimmt: Der
  unverschlüsselte Port ist dann von außen nicht erreichbar.

### Start prüfen

```bash
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Nach ein paar Sekunden zeigt `ps` die Anwendung als `healthy`, und der
Health-Endpunkt liefert `{"status":"ok",...}`. Sobald der Proxy steht, öffnest
du deine `BASE_URL` mit `/admin` und meldest dich an. Mit einer
`https://`-`BASE_URL` ist das Login-Cookie Secure, über unverschlüsseltes
`http://<host>:3000` klappt die Anmeldung deshalb nicht. Willst du dich
vorher anmelden, nutz `http://localhost:3000` auf dem Host selbst (etwa über
`ssh -L 3000:127.0.0.1:3000 <host>`). Bricht Compose mit „set SECRET_KEY in .env“ ab, hilft die
[Fehlerbehebung](10-troubleshooting.md#start). Für HTTPS geht es mit dem
[Reverse Proxy](03-reverse-proxy.md) weiter.

### Befehle für den Alltag

Führ alle Befehle im Verzeichnis mit `compose.yaml` und `.env` aus. Compose
findet dort beide Dateien, weitere Optionen brauchst du nicht:

```bash
docker compose ps                              # Zustand der Dienste
docker compose logs -f openstatuspage          # Log der Anwendung verfolgen
docker compose pull && docker compose up -d    # neue Images, .env übernehmen
docker compose exec openstatuspage node server/dist/cli/create-user.js ...
docker compose down                            # Container stoppen und entfernen
```

`down` lässt die Volumes stehen. Hänge nie `-v` an, außer du willst die
Datenbank löschen. Sicherungen und Updates beschreibt
[Betrieb](09-operations.md).

Eine zweite Instanz auf demselben Host braucht ein eigenes Verzeichnis,
einen eigenen `HOST_PORT` und einen eigenen Projektnamen: Starte sie mit
`docker compose -p openstatuspage2 up -d` und gib `-p openstatuspage2` bei
jedem Befehl an, oder trag `COMPOSE_PROJECT_NAME=openstatuspage2` in ihre
`.env` ein.

### Aus einem Klon des Repositorys

Dieselben Dateien liegen im Repository unter `deploy/compose/`; die Vorlage
heißt dort `.env.example`:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage/deploy/compose
cp .env.example .env
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
chmod 600 .env
# .env bearbeiten wie oben
docker compose up -d
```

Diese Dateien folgen dem Branch `main` und nutzen standardmäßig
`OSP_VERSION=latest`; leg in `.env` ein Release fest. Alle Befehle führst du
in `deploy/compose` aus.

### Optionale Demodaten

Zum Ausprobieren mit fiktiven Daten füllst du eine **leere** Datenbank einmalig:

```bash
docker compose exec openstatuspage node server/dist/cli/seed.js
```

Der Befehl bricht ab, wenn schon Services existieren. Verwende ihn nicht auf
einer produktiven Instanz.

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
`1.3` und `1` bleiben davon unberührt.

**Leg dich im Produktivbetrieb auf ein Release fest** (`1.2.3`) und update
bewusst, nachdem du die Release Notes gelesen und eine Sicherung gemacht hast
(siehe [Updates](09-operations.md#updates)). Mit einem mitwandernden Tag kann
schon ein `pull` die Datenbank ohne Vorwarnung migrieren, und
[Migrationen gehen nur vorwärts](09-operations.md#zurückrollen). Am
strengsten pinnst du mit dem Digest des Images statt eines Tags
(`ghcr.io/raphael-penning/openstatuspage@sha256:...`, angezeigt von
`docker buildx imagetools inspect`). Wie Images und Releases entstehen,
beschreibt [`docs/releasing.md`](../../releasing.md).

## Geteilte Installation

Bei der geteilten Installation laufen die öffentliche Statusseite und der
Admin-Bereich als zwei Instanzen auf zwei Domains, dazu ein Hintergrund-Worker,
alle auf einer gemeinsamen PostgreSQL-Datenbank. Der Sinn ist die Eingrenzung:
Die öffentliche Instanz erreicht weder den Admin-Bereich noch die
Monitoring-Systeme oder die Admin-Tabellen. Eine Schwachstelle in der
öffentlichen Anwendung oder eine gestohlene Admin-Sitzung kann so keine Daten
über die öffentliche Instanz nach außen leiten.

| Container | `APP_ROLE` | Bedient | Datenbankrolle | Port auf dem Host |
| --- | --- | --- | --- | --- |
| `public` | `public` | Statusseite, öffentliche API, Feeds, Abonnements, `/api/health` | `osp_public` (kein Tabellenzugriff) | `PUBLIC_HOST_PORT`, Standard 3000 |
| `admin` | `admin` | Verwaltungsoberfläche und API, Login, OIDC, Ingest, öffentliche Seite zur Vorschau | Eigentümerrolle (`POSTGRES_USER`) | `ADMIN_HOST_PORT`, Standard 3001 |
| `worker` | `worker` | Polling, Mails, Wartungen, Bundles, Importe, Aufräumen; nur `/api/health` | Eigentümerrolle | keiner |
| `db` | – | PostgreSQL 17, nicht veröffentlicht | – | keiner |

Der Container `public` hat keine `env_file`-Angabe und bekommt nur seine eigenen
Einstellungen: kein Admin-Passwort, keine OIDC- oder SMTP-Geheimnisse und keinen
Weg zu den Monitoring-Systemen (die fragt der Worker ab). Er führt nie
Migrationen aus und wartet, bis die Admin-Instanz das Schema auf den aktuellen
Stand gebracht hat. Die Datenbankrolle `osp_public` sieht nur die öffentlichen
Views und ruft nur die Abonnement-Funktionen auf, siehe
[Sicherheitsmodell](../../security-model.md).

### Einrichtung

Du brauchst dasselbe wie für [Docker Compose](#docker-compose), dazu einen Klon
des Repositorys, weil die Datei das Init-Skript aus `deploy/postgres/` nutzt:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage/deploy/compose
cp .env.example .env
chmod 600 .env
printf 'SECRET_KEY=%s\nSUBSCRIPTION_TOKEN_KEY=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_PUBLIC_PASSWORD=%s\nPOSTGRES_APP_PASSWORD=%s\n' \
  "$(openssl rand -base64 48)" "$(openssl rand -base64 48)" \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" >> .env
# .env bearbeiten, siehe unten
docker compose -f compose.split.yaml up -d
```

Trage in `.env` die Variablen des Abschnitts *Split deployment* ein und entferne
das Kommentarzeichen davor:

- `PUBLIC_BASE_URL`, die öffentliche Domain, zum Beispiel `https://status.example.com`.
- `ADMIN_BASE_URL`, die Admin-Domain, zum Beispiel `https://status.admin.example.com`.
- `ADMIN_EMAIL` und `ADMIN_PASSWORD` für den ersten Administrator (wie unter
  [Minimale Konfiguration](#minimale-konfiguration)).
- `TRUST_PROXY`, die Anzahl der Proxys vor jeder Instanz (1 bei einem Proxy).
- `PUBLIC_BIND` und `ADMIN_BIND` behältst du auf `127.0.0.1`, wenn dein Reverse
  Proxy auf demselben Host läuft.

Verwende in `POSTGRES_PASSWORD`, `POSTGRES_PUBLIC_PASSWORD` und
`POSTGRES_APP_PASSWORD` nur Buchstaben und Ziffern: Sie stehen in
Verbindungs-URLs. `BASE_URL` in `.env` nutzt diese
Datei nicht; die Compose-Datei setzt die Basis-URL jedes Containers selbst.
Nur Admin und Worker bekommen `SECRET_KEY`; der öffentliche Container bekommt
stattdessen `SUBSCRIPTION_TOKEN_KEY`, den Schlüssel der Abonnement-Links.

Das Init-Skript legt die Rollen `osp_public` (öffentlicher Container,
`POSTGRES_PUBLIC_PASSWORD`) und `osp_app` (Admin und Worker,
`POSTGRES_APP_PASSWORD`, kein Superuser) an, wenn das Datenvolumen zum ersten
Mal erstellt wird. Ist dieser Schritt
fehlgeschlagen, ist die Datenbank bereits initialisiert, und das Skript läuft
nicht erneut: Stoppe den Stack, entferne das Volume `openstatuspage-split_pg`
(dabei gehen die Daten verloren) und starte neu.

### Reverse Proxys

Jede Instanz veröffentlicht einfaches HTTP auf einem eigenen Host-Port. Stelle
davor je einen Proxy-Host:

| Domain | Zeigt auf | Hinweise |
| --- | --- | --- |
| `status.example.com` | `127.0.0.1:3000` | die öffentliche Seite; für alle offen |
| `status.admin.example.com` | `127.0.0.1:3001` | der Admin-Bereich; schränke ihn ein, zum Beispiel per IP-Adresse, VPN oder Zugangsproxy |

Die Proxy-Einstellungen stehen unter [Reverse Proxy](03-reverse-proxy.md). Veröffentliche
die Admin-Domain nicht ohne Einschränkung im Internet: Dafür gibt es zwei
getrennte Instanzen.

### Installation prüfen

```bash
docker compose -f compose.split.yaml ps
curl -fsS http://127.0.0.1:3000/api/health   # öffentlich
curl -fsS http://127.0.0.1:3001/api/health   # Admin
docker compose -f compose.split.yaml logs --tail 50 worker
```

Melde dich danach unter `https://status.admin.example.com` an und prüfe, dass
die Statusseite unter `https://status.example.com` lädt. Das Log des Workers
zeigt die Polling- und Mail-Aufgaben; es sollte keine Fehler enthalten.

### Updates und Passwörter

Fixiere `OSP_VERSION` auf ein Release, wie unter [Image-Tags](#image-tags)
beschrieben, und mache vorher ein Backup ([Betrieb](09-operations.md)). Führe
dann `docker compose -f compose.split.yaml pull` und
`docker compose -f compose.split.yaml up -d` aus. Die Admin-Instanz migriert das
Schema; die öffentliche Instanz wartet darauf (`SCHEMA_WAIT_SECONDS`).

Um `POSTGRES_PUBLIC_PASSWORD` oder `POSTGRES_APP_PASSWORD` später zu ändern,
passe es in `.env` an (nur Buchstaben und Ziffern) und führe dann aus:

```bash
docker compose -f compose.split.yaml up -d db
docker compose -f compose.split.yaml exec db /docker-entrypoint-initdb.d/10-roles.sh
docker compose -f compose.split.yaml up -d public admin worker
```

### Was die geteilte Installation nicht abdeckt

- **Admin und Worker besitzen die Tabellen.** Sie verbinden sich als
  `osp_app`. Diese Rolle ist kein Superuser, besitzt aber alle Tabellen und darf
  alle Daten lesen und ändern. Ein kompromittierter Admin- oder Worker-Container
  hat deshalb vollen Zugriff auf die Daten der Anwendung (nicht auf andere
  Datenbanken oder den Server). Die Trennung schützt die öffentliche Seite: Nur
  die Rolle `osp_public` ist dem Internet zugewandt.
- **Gemeinsame Geheimnisse.** Admin und Worker haben `SECRET_KEY`, alle drei
  Container haben `SUBSCRIPTION_TOKEN_KEY`. Halte die `.env`-Datei privat und
  sichere sie, siehe [Betrieb](09-operations.md#secret_key).
- **Nur PostgreSQL.** SQLite ist eine Datenbank für eine einzelne Instanz und
  unterstützt nur die Rolle `all`.
- **Ein Host.** Die Compose-Datei ist ein Beispiel für eine Maschine. Für mehrere
  Hosts oder mehr Replikate siehe [Kubernetes](#kubernetes) und
  [Mehrere Instanzen betreiben](09-operations.md#mehrere-instanzen-betreiben).

Das Kubernetes-Beispiel für die geteilte Installation liegt in
Die Manifeste liegen in `deploy/kubernetes/split/` (anwenden mit
`kubectl apply -k deploy/kubernetes/split`).

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

Auch `compose.yaml` funktioniert mit SQLite: Entferne den Dienst `db`, den
Block `depends_on`, das Volume `pg` und die Zeile `DATABASE_URL`. Die Daten
liegen dann im Volume `data`.

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
Override-Datei `deploy/compose/compose.build.yaml` baut das Image aus dem
Klon (`docker/Dockerfile`) und nennt es `openstatuspage:local`. Leg `.env`
an wie [aus einem Klon](#aus-einem-klon-des-repositorys) beschrieben, dann:

```bash
cd openstatuspage/deploy/compose
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Gib beide `-f`-Dateien bei jedem weiteren Befehl an, oder trag
`COMPOSE_FILE=compose.yaml:compose.build.yaml` in `.env` ein; dann nutzen
auch einfache `docker compose ...`-Befehle beide. Nach jedem `git pull`
führst du erneut `up -d --build` aus. Ohne Compose baust du im
Wurzelverzeichnis des Repositorys mit
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
   `ADMIN_PASSWORD` nach der ersten Anmeldung aus der Umgebung (aus `.env`
   mit anschließendem `docker compose up -d` oder aus dem Kubernetes-Secret)
   und ändere das Passwort im Benutzermenü.
2. **Der Befehl `create-user`** legt einen Benutzer an oder setzt, wenn die
   Adresse schon existiert, ein neues Passwort und die Rolle und beendet die
   Sitzungen des Benutzers:

   ```bash
   # Docker Compose
   docker compose exec openstatuspage \
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

- `curl -fsS http://127.0.0.1:3000/api/health` liefert `{"status":"ok",...}`, wenn
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
