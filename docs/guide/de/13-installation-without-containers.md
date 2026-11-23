# Installation ohne Container

OpenStatusPage läuft auch direkt auf einem Linux-Server mit systemd, ohne
Docker. Jedes Release enthält dafür diese Dateien:

| Datei | Inhalt |
| --- | --- |
| `openstatuspage-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` | Der gebaute Server und Web-Client mit ihren Produktionsabhängigkeiten, die systemd-Units, der Starter, die Reverse-Proxy-Vorlagen und `install.sh`. |
| `openstatuspage_<version>_amd64.deb`, `…_arm64.deb` | Paket für Debian und Ubuntu mit demselben Inhalt. |
| `openstatuspage-<version>-1.x86_64.rpm`, `…aarch64.rpm` | Paket für RHEL, Rocky, AlmaLinux und Fedora mit demselben Inhalt. |
| `install.sh` | Das Installationsskript (auch im Tarball als `scripts/install.sh`). |
| `SHA256SUMS` | SHA-256-Prüfsummen aller Dateien oben. |

Wähle einen Weg:

| Variante | Geeignet für |
| --- | --- |
| [Installationsskript](#installationsskript) | die meisten Server: ein Befehl, richtet bei Bedarf Node.js, PostgreSQL und einen Mailserver ein, Updates mit Prüfsummenprüfung |
| [Pakete](#pakete) | Hosts, die du mit apt oder dnf verwaltest, Konfigurationsmanagement |
| [Tarball von Hand](#tarball-von-hand) | volle Kontrolle über jeden Schritt |
| [Aus dem Quellcode](#aus-dem-quellcode) | Entwicklung, eigene Änderungen |

Unterstützt: Debian 11 oder neuer, Ubuntu 22.04 oder neuer, RHEL, Rocky Linux
und AlmaLinux 9 oder neuer, Fedora; `x86_64` und `aarch64`. Die nativen Module
des Releases sind gegen glibc 2.31 gebaut. Alpine Linux (musl, OpenRC) wird von
diesen Dateien nicht unterstützt: nimm dort das
[Container-Image](02-installation.md) oder baue auf dem Host aus dem Quellcode.

Jeder Weg startet dasselbe Programm wie das Container-Image, mit denselben
Speichereinstellungen, und braucht **Node.js 22** (genau diese Hauptversion:
die nativen Module sind dafür gebaut). Stelle einen Reverse Proxy mit HTTPS
davor, siehe [Reverse Proxy](#reverse-proxy).

## Installationsskript

Das Skript installiert ein Release nach `/opt/openstatuspage/app`, schreibt
die Einstellungen nach `/etc/openstatuspage/openstatuspage.env` (Modus `0640`,
sie enthält Geheimnisse), legt die Daten in `/var/lib/openstatuspage` ab und
installiert gehärtete systemd-Units. Es prüft die SHA-256 des Downloads gegen
die `SHA256SUMS` des Releases, erzeugt `SECRET_KEY` bei der ersten
Installation und überschreibt nie vorhandene Einstellungen oder Daten. Du
kannst es also jederzeit erneut ausführen, zum Beispiel um später PostgreSQL
oder den Mailserver hinzuzufügen.

```bash
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/install.sh
less install.sh   # lies, was es tut
sudo bash install.sh install --base-url https://status.example.com
```

Trage danach den ersten Administrator in
`/etc/openstatuspage/openstatuspage.env` ein (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
siehe [der erste Administrator](02-installation.md#der-erste-administrator))
und führe `sudo systemctl restart openstatuspage` aus. Die App lauscht auf
`127.0.0.1:3000`.

Optionen von `install`:

| Option | Bedeutung |
| --- | --- |
| `--base-url URL` | Öffentliche URL der Statusseite (`BASE_URL`). |
| `--version X.Y.Z` | Dieses Release statt des neuesten installieren. |
| `--tarball DATEI` | Einen lokalen Tarball installieren; `SHA256SUMS` muss daneben liegen. |
| `--with-postgres` | PostgreSQL aus der Distribution installieren, die Datenbank `openstatuspage` und die Rollen aus `deploy/postgres/roles.sql` mit erzeugten Passwörtern anlegen (nur für root lesbar in `/etc/openstatuspage/.database-passwords`), ihre Passwortanmeldung über das Loopback-Interface erlauben und `DATABASE_URL` darauf setzen. Ohne die Option wird SQLite in `/var/lib/openstatuspage` verwendet. |
| `--database-url URL` | Ein vorhandenes PostgreSQL verwenden (Anmeldung der App-Rolle). |
| `--mode split` | Die [geteilte Installation](#geteilte-installation): Public, Admin und Worker als drei Dienste. |
| `--admin-url URL`, `--public-database-url URL` | Admin-Domain und Anmeldung der eingeschränkten Public-Rolle für `--mode split` (mit `--with-postgres` nicht nötig). |
| `--with-postfix --mail-domain example.com` | Ein lokales Postfix nur zum Versenden, mit DKIM, siehe [Mailserver](#mailserver). |
| `--mail-hostname NAME`, `--mail-relayhost HOST`, `--dkim-selector NAME` | Nur mit `--with-postfix`: HELO-Name (Standard: die Mail-Domain), ein Smarthost wie `[smtp.example.com]:587` und der DKIM-Selector (Standard: `osp`). |
| `--node MODUS` | `system`: Node.js 22 aus dem `PATH`; `bundled`: eine eigene Kopie in `/opt/openstatuspage/node` von nodejs.org (geprüft gegen deren `SHASUMS256.txt`). `auto` (Standard) nimmt ein passendes `node` aus dem `PATH` und installiert sonst die eigene Kopie. |
| `--no-start` | Den Dienst weder aktivieren noch starten. |

### Was das Skript ändert

- Pakete: `curl`, `tar` und `gzip`, falls sie fehlen; PostgreSQL, Postfix und
  OpenDKIM nur mit der passenden Option (auf Rocky und RHEL kommt OpenDKIM aus
  EPEL, das das Skript dafür aktiviert).
- Die Benutzer `openstatuspage` (führt die Dienste aus) und
  `openstatuspage-public` (führt nur die Public-Instanz der geteilten
  Installation aus), beide ohne Login.
- `/opt/openstatuspage/app` (das Release, gehört root), das vorige Release in
  `/opt/openstatuspage/app.previous`, optional `/opt/openstatuspage/node`.
- `/etc/openstatuspage` (Einstellungen, root und Gruppe `openstatuspage`),
  `/var/lib/openstatuspage` (Daten).
- Die Units `openstatuspage.service`, `openstatuspage-public.service`,
  `openstatuspage-admin.service`, `openstatuspage-worker.service` und
  `openstatuspage-split.target` in `/etc/systemd/system`.

Die Units laufen als unprivilegierter Benutzer mit `ProtectSystem=strict` (nur
`/var/lib/openstatuspage` ist beschreibbar), `NoNewPrivileges`, `PrivateTmp`,
`PrivateDevices`, leerem Capability-Bounding-Set, einem Systemaufruf-Filter und
`MemoryMax=256M`. Sieh sie dir mit `systemctl cat openstatuspage` an.

### Geteilte Installation

Dieselbe Aufteilung wie mit [Compose](02-installation.md#geteilte-installation):
öffentliche Seite und Admin-Bereich auf getrennten Domains, der Worker für
sich. Sie braucht PostgreSQL.

```bash
sudo bash install.sh install --mode split --with-postgres \
  --base-url https://status.example.com --admin-url https://status.admin.example.com
```

| Dienst | Port | Einstellungen |
| --- | --- | --- |
| `openstatuspage-public` | 3000 | Nur `/etc/openstatuspage/public.env`. Er läuft als `openstatuspage-public` und kann die anderen Dateien nicht lesen, sieht also nie `SECRET_KEY`, das Admin-Passwort, SMTP-Zugangsdaten oder die Datenbankanmeldung des Eigentümers. |
| `openstatuspage-admin` | 3001 | `openstatuspage.env`, dann `admin.env` |
| `openstatuspage-worker` | 3002 (nur Health) | `openstatuspage.env`, dann `worker.env` |

`systemctl restart openstatuspage-split.target` startet alle drei neu. Die
Proxy-Vorlagen für zwei Domains sind `Caddyfile.split` und `nginx.split.conf`.

### Update, Rollback, Deinstallation

```bash
sudo bash /opt/openstatuspage/app/scripts/install.sh update            # neuestes Release
sudo bash /opt/openstatuspage/app/scripts/install.sh update --version 0.4.0
sudo bash /opt/openstatuspage/app/scripts/install.sh rollback          # zurück zum vorigen Release
sudo bash /opt/openstatuspage/app/scripts/install.sh uninstall
```

`update` lädt das Release und seine `SHA256SUMS`, prüft die Prüfsumme, ersetzt
`/opt/openstatuspage/app` (das alte bleibt als `app.previous`), aktualisiert
die eigene Node.js-22-Kopie, falls vorhanden, startet die laufenden Dienste
neu und wartet auf `/api/health`. Das neue Release migriert die Datenbank beim
Start; `rollback` holt das Programm zurück, aber nicht das alte Schema. Lege
deshalb vorher ein [Sicherung](09-operations.md#sicherung-und-wiederherstellung) an.

`uninstall` stoppt und entfernt die Dienste und `/opt/openstatuspage`. Es
behält die Einstellungen, die Daten, die Benutzer und ein vom Skript
eingerichtetes PostgreSQL oder Postfix; lösche sie von Hand, wenn du sie nicht
mehr brauchst.

## Pakete

Die `.deb`- und `.rpm`-Pakete enthalten genau den Tarball und die Units. Ihre
Skripte legen die Benutzer und Verzeichnisse an und bei der ersten
Installation die Einstellungsdatei mit einem erzeugten `SECRET_KEY`. Sie
aktivieren oder starten bei einer Neuinstallation nie einen Dienst,
überschreiben nie die Einstellungen und behalten Einstellungen und Daten, wenn
du das Paket entfernst. Ein Upgrade startet die laufenden Dienste neu.

```bash
# Debian, Ubuntu
sudo apt install ./openstatuspage_0.4.0_amd64.deb
# RHEL, Rocky, AlmaLinux, Fedora
sudo dnf install ./openstatuspage-0.4.0-1.x86_64.rpm
```

Die Pakete empfehlen `nodejs` 22, bringen es aber nicht mit, weil die meisten
Distributionen eine andere Version liefern. Installiere Node.js 22 aus deiner
Distribution (zum Beispiel den Modul-Stream `nodejs:22` unter RHEL 9) oder von
NodeSource, oder führe `sudo /opt/openstatuspage/app/scripts/install.sh node`
für die eigene Kopie aus. Bearbeite dann
`/etc/openstatuspage/openstatuspage.env` und führe
`sudo systemctl enable --now openstatuspage` aus. Updates laufen über
`apt`/`dnf`; `install.sh update` lässt eine Paketinstallation unangetastet.

## Tarball von Hand

```bash
version=0.4.0
curl -fsSLO "https://github.com/Raphael-Penning/openstatuspage/releases/download/v$version/openstatuspage-$version-linux-x64.tar.gz"
curl -fsSLO "https://github.com/Raphael-Penning/openstatuspage/releases/download/v$version/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
sudo mkdir -p /opt/openstatuspage
sudo tar -xzf "openstatuspage-$version-linux-x64.tar.gz" -C /opt/openstatuspage
sudo mv "/opt/openstatuspage/openstatuspage-$version-linux-x64" /opt/openstatuspage/app
```

Erledige dann von Hand, was das Skript tut: Benutzer, Verzeichnisse und
`/etc/openstatuspage/openstatuspage.env` aus
`/opt/openstatuspage/app/share/openstatuspage.env.example` anlegen und die
Units aus `/opt/openstatuspage/app/share/systemd/` nach `/etc/systemd/system/`
kopieren. Der Starter `/opt/openstatuspage/app/bin/openstatuspage` führt auch
die CLI-Befehle als Dienstbenutzer aus, zum Beispiel:

```bash
sudo -u openstatuspage /opt/openstatuspage/app/bin/openstatuspage create-user --help
```

## Aus dem Quellcode

Für die Entwicklung oder eigene Änderungen brauchst du Node.js 22, pnpm
(`corepack enable`) und, wenn kein vorgebautes Binary zu deiner Plattform
passt, `python3`, `make` und einen C++-Compiler für die nativen Module.

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Am einfachsten machst du aus dem Build einen Tarball und installierst ihn mit
dem Skript. So bekommst du dieselben Units und dasselbe Layout wie bei einem
Release:

```bash
scripts/build-bundle.sh 0.4.0-local.1          # schreibt dist/release/openstatuspage-0.4.0-local.1-linux-<arch>.tar.gz
(cd dist/release && sha256sum -- *.tar.gz > SHA256SUMS)
sudo bash scripts/install.sh install --tarball dist/release/openstatuspage-0.4.0-local.1-linux-x64.tar.gz
```

Ohne das Skript startet `pnpm start` den Server aus `apps/server`; er liest
`.env` aus dem Arbeitsverzeichnis oder die Datei in `ENV_FILE`. Die Unit unter
[Aus dem Quellcode](02-installation.md#aus-dem-quellcode) zeigt einen minimalen
Dienst; übernimm die Härtungszeilen aus
`deploy/bare-metal/systemd/openstatuspage.service`. Für Hot Reload in der
Entwicklung siehe `CONTRIBUTING.md`.

## Reverse Proxy

`deploy/proxy/` enthält Vorlagen für Caddy (automatische Zertifikate) und
nginx, für eine Instanz und für die geteilte Installation; im Tarball liegen
sie in `/opt/openstatuspage/app/share/proxy`. Siehe die
[README](../../../deploy/proxy/README.md). Sie erwarten die App auf
`127.0.0.1`, deshalb ist `TRUST_PROXY=1` sicher: niemand erreicht den Port der
App am Proxy vorbei. Läuft der Proxy auf einem anderen Host, lass die App auf
ihrer privaten Adresse lauschen und setze `TRUST_PROXY` auf die Adresse des
Proxys statt auf eine Anzahl, siehe [TRUST_PROXY](03-reverse-proxy.md#trust_proxy).

## Mailserver

Abonnement- und Benachrichtigungs-E-Mails brauchen einen Mailserver. Die
Compose-Dateien und das Installationsskript bringen dafür ein Postfix nur zum
Versenden mit, das mit DKIM signiert; du kannst jederzeit stattdessen einen
anderen Server nehmen.

### Mitgeliefertes Postfix mit Docker Compose

`compose.yaml` und `compose.split.yaml` enthalten einen Dienst `postfix` (das
verbreitete Image `boky/postfix`, auf eine Version festgelegt). In einer neuen
`.env` ist er eingeschaltet:

```bash
COMPOSE_PROFILES=mail
MAIL_DOMAIN=example.com
```

Die App sendet dann als `Status <status@example.com>` über `postfix`, ohne
eine einzige `SMTP_*`-Einstellung. Der Mailserver

- erzeugt beim ersten Start einen DKIM-Schlüssel (Selektor `osp`) im Volume
  `dkim` und signiert jede E-Mail damit;
- kopiert nur den **öffentlichen** Schlüssel ins Volume `dkim-public`, das die
  App schreibgeschützt einbindet (`MAIL_DKIM_DIR`), um die DNS-Einträge
  anzuzeigen;
- wird nie auf einem Host-Port veröffentlicht, liegt mit der App in einem
  internen Netz (die Public-Instanz der geteilten Installation nicht) und
  leitet nur für dieses Netz weiter (`MAIL_SUBNET`, Standard
  `172.30.250.0/28`, `…251.0/28` bei der geteilten Installation; ändere es,
  wenn es sich mit einem Netz deines Hosts überschneidet) und nur für Absender
  aus `MAIL_DOMAIN`.

Ohne `MAIL_RELAYHOST` stellt er direkt bei den Servern der Empfänger zu. Das
braucht ausgehenden Port 25 (bei vielen Cloud-Anbietern gesperrt), einen
PTR-Eintrag für die Adresse des Hosts, der zu `MAIL_HOSTNAME` passt (Standard:
`MAIL_DOMAIN`), und die DNS-Einträge unten. Andernfalls leite über deinen
Anbieter weiter: `MAIL_RELAYHOST=[smtp.example.com]:587` mit
`MAIL_RELAYHOST_USERNAME` und `MAIL_RELAYHOST_PASSWORD`. Eine Subdomain wie
`status.example.com` als `MAIL_DOMAIN` hält diese Einträge von deiner übrigen
Mail getrennt.

### Lokales Postfix mit dem Installationsskript

```bash
sudo bash install.sh install --with-postfix --mail-domain example.com
```

installiert Postfix und OpenDKIM, nur auf `127.0.0.1` erreichbar
(`inet_interfaces = loopback-only`, keine lokale Zustellung, Weiterleitung nur
für `127.0.0.1`/`::1`), erzeugt den Schlüssel in
`/etc/opendkim/keys/example.com/osp.private` und kopiert den öffentlichen
Schlüssel nach `/etc/openstatuspage/dkim`. Es setzt `SMTP_HOST=127.0.0.1`,
`SMTP_PORT=25`, `SMTP_FROM` und `MAIL_DKIM_DIR` in den Einstellungen. Ein schon
vorher installiertes Postfix, Exim oder Sendmail übernimmt das Skript nicht;
`--mail-relayhost` und `--mail-hostname` funktionieren wie die
Compose-Variablen.

### DNS-Einträge

Sobald die App den öffentlichen Schlüssel kennt, zeigt
**Einstellungen → E-Mail-Versand** die Einträge für die Absender-Domain, jeweils
mit Kopier-Button:

| Eintrag | Name | Wert |
| --- | --- | --- |
| SPF | `example.com` | `v=spf1 ip4:<server-ipv4> ip6:<server-ipv6> -all`: setze die Adressen ein, von denen der Server sendet. Hat die Domain schon einen SPF-Eintrag, ergänze ihn; eine Domain darf nur einen haben. |
| DKIM | `osp._domainkey.example.com` | `v=DKIM1; k=rsa; p=…` (der erzeugte Schlüssel) |
| DMARC | `_dmarc.example.com` | `v=DMARC1; p=quarantine; adkim=s; aspf=s`. Beginne mit `p=none`, während du die Berichte prüfst, und verschärfe danach. |

Dieselben Einträge liefert die API (`dns` in
`GET /api/admin/notifications/status`). Sende danach eine
[Test-E-Mail](07-email-subscriptions.md#test-e-mail) und prüfe ihre Header
(`dkim=pass`, `spf=pass`).

### Anderer Mailserver

Setze `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` und `SMTP_FROM`
(siehe [Mailserver](07-email-subscriptions.md#mailserver)); sie haben immer
Vorrang vor dem mitgelieferten Postfix. Mit Compose entferne außerdem
`MAIL_DOMAIN` und `mail` aus `COMPOSE_PROFILES` (leeres `COMPOSE_PROFILES=` oder
die Zeile löschen); `docker compose up -d --remove-orphans` stoppt dann den
Dienst `postfix`. Die Volumes `dkim` und `dkim-public` bleiben, bis du sie
löschst.

## Fehlersuche

- `journalctl -u openstatuspage -n 100` (oder `-u 'openstatuspage*'` bei der
  geteilten Installation) zeigt Startfehler, zum Beispiel eine fehlende
  Einstellung.
- `Node.js 22 is required`: installiere Node.js 22 oder führe `install.sh node` aus.
- `curl http://127.0.0.1:3000/api/health` antwortet `{"status":"ok"}`, solange
  die Datenbank erreichbar ist.
- Mail: `journalctl -u postfix -u opendkim` (Skript) oder
  `docker compose logs postfix` (Compose); der Bereich **E-Mail-Versand** zeigt
  den letzten Zustellfehler.
