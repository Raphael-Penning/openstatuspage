# Reverse Proxy und HTTPS

OpenStatusPage spricht reines HTTP. Im Produktivbetrieb steht davor ein
Reverse Proxy, der HTTPS übernimmt. Drei Dinge müssen zusammenpassen:

1. Der Proxy leitet an die Anwendung weiter (standardmäßig Port 3000) und
   setzt die `X-Forwarded-*`-Header.
2. `BASE_URL` ist genau die öffentliche URL, z. B. `https://status.example.com`.
3. `TRUST_PROXY` sagt der Anwendung, wie vielen Proxys sie vertrauen soll,
   damit sie die echte IP des Clients sieht.

Läuft der Proxy auf demselben Host, veröffentlichst du den Port der Anwendung
nur auf localhost (`HOST_PORT=127.0.0.1:3000` in `.env` mit Docker
Compose, `-p 127.0.0.1:3000:3000` beim einzelnen Container, `HOST=127.0.0.1`
beim Betrieb aus dem Quellcode). So kann niemand den Proxy umgehen. Unter
Kubernetes übernimmt der [Ingress](#kubernetes-ingress) die Rolle des Proxys.

Mit Docker Compose kommen `BASE_URL`, `TRUST_PROXY` und `HOST_PORT` in
`.env` neben `compose.yaml` (siehe
[Installation](02-installation.md#einstellungen-in-env)); die Vorlage
enthält `TRUST_PROXY=1` bereits. Änderungen übernimmst du mit
`docker compose up -d`.

## BASE_URL

`BASE_URL` wird verwendet für:

- Links in RSS-/Atom-Feeds und in Benachrichtigungs-E-Mails,
- die OIDC-Redirect-URI `${BASE_URL}/api/auth/oidc/callback`,
- die Ingest-URLs, die bei Monitoring-Quellen angezeigt werden,
- das `Secure`-Flag der Cookies: Beginnt `BASE_URL` mit `https://`, wird das
  Sitzungs-Cookie nur über HTTPS gesendet.

Trag die URL ein, die deine Benutzer im Browser aufrufen, ohne
abschließenden Schrägstrich und ohne Pfad. Der Betrieb unter einem Unterpfad
(z. B. `https://example.com/status/`) wird nicht unterstützt; nimm einen
eigenen Hostnamen.

## TRUST_PROXY

Hinter einem Proxy kommen alle Anfragen von der Adresse des Proxys. Die
Anwendung braucht die IP des Clients aber für Rate Limits (Anmeldung,
Abonnements) und Sitzungsdaten. Sie übernimmt sie aus `X-Forwarded-For` nur so
weit, wie du es erlaubst:

| Wert | Bedeutung |
| --- | --- |
| `false` (Standard) | Kein Proxy. Die TCP-Gegenstelle ist der Client. Hinter einem Proxy teilen sich dann alle Clients eine IP und ein Rate Limit. |
| `1` oder `true` | Genau ein Proxy vor der Anwendung (der Normalfall). |
| `2`, `3`, ... | Entsprechend viele Proxys hintereinander, z. B. ein CDN oder Load Balancer vor deinem Proxy. |
| `10.0.0.0/8,127.0.0.1` | Nur Proxys mit diesen Adressen bzw. aus diesen Netzen vertrauen. |

`true` bedeutet einen Hop, nicht „allen vertrauen“. Setze den Wert genau auf
die Anzahl der Proxys, die du betreibst: Einträge weiter links in
`X-Forwarded-For` stammen vom Client und können gefälscht sein. Ist der Wert
zu hoch, können Clients sich ihre IP aussuchen und Rate Limits umgehen.

## Caddy

Caddy holt Zertifikate automatisch und setzt die Forwarding-Header von sich
aus.

```caddyfile
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Konfiguration: `BASE_URL=https://status.example.com`, `TRUST_PROXY=1`.

### Caddy im Compose-Setup

Caddy kann auch als dritter Dienst neben der Anwendung laufen. Leg dazu zwei
Dateien neben `compose.yaml` an:

```caddyfile
# Caddyfile
status.example.com {
    reverse_proxy openstatuspage:3000
}
```

```yaml
# compose.caddy.yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - openstatuspage

volumes:
  caddy_data:
  caddy_config:
```

Setze in `.env` `BASE_URL=https://status.example.com`, `TRUST_PROXY=1` und
`HOST_PORT=127.0.0.1:3000`: Caddy erreicht die Anwendung über das
Compose-Netz, und der veröffentlichte Port bleibt für deine eigenen
Prüfungen auf localhost. Starte alles mit beiden Dateien:

```bash
docker compose -f compose.yaml -f compose.caddy.yaml up -d
```

Gib beide Dateien bei jedem weiteren Befehl an, oder trag
`COMPOSE_FILE=compose.yaml:compose.caddy.yaml` in `.env` ein; dann schließen
auch einfache `docker compose ...`-Befehle Caddy ein.

Der DNS-Name muss auf den Host zeigen, und die Ports 80 und 443 müssen aus
dem Internet erreichbar sein, damit Caddy das Zertifikat bekommt. Das Volume
`caddy_data` enthält die Zertifikate; lösche es nicht.

## nginx

```nginx
server {
    listen 80;
    server_name status.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name status.example.com;

    ssl_certificate     /etc/letsencrypt/live/status.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/status.example.com/privkey.pem;

    # Sammel-Uploads von Monitoring-Systemen können bis zu 5 MiB groß sein.
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Konfiguration: `BASE_URL=https://status.example.com`, `TRUST_PROXY=1`.
Zertifikate bekommst du z. B. mit certbot oder einem anderen ACME-Client.

## Traefik

Läuft Traefik als Docker-Container, ergänzt du am Dienst `openstatuspage`
in einer Override-Datei neben `compose.yaml` Labels. Traefik erreicht den
Container direkt; lass `HOST_PORT=127.0.0.1:3000` (oder einen anderen Port
auf localhost) stehen:

```yaml
# compose.traefik.yaml
services:
  openstatuspage:
    labels:
      - traefik.enable=true
      - traefik.http.routers.openstatuspage.rule=Host(`status.example.com`)
      - traefik.http.routers.openstatuspage.entrypoints=websecure
      - traefik.http.routers.openstatuspage.tls.certresolver=letsencrypt
      - traefik.http.services.openstatuspage.loadbalancer.server.port=3000
```

Setze `BASE_URL=https://status.example.com` und `TRUST_PROXY=1` in `.env`
und starte mit `docker compose -f compose.yaml -f compose.traefik.yaml up -d`
(oder `COMPOSE_FILE=compose.yaml:compose.traefik.yaml` in `.env`).
Entrypoint (`websecure`) und Zertifikats-Resolver (`letsencrypt`) sind die
Namen aus deiner statischen Traefik-Konfiguration. Der Container muss in
einem Netz hängen, mit dem Traefik verbunden ist (trag es in der
Override-Datei unter `networks:` ein, wenn Traefik in einem anderen
Compose-Projekt läuft).

## Kubernetes-Ingress

Mit den [Kubernetes-Manifesten](02-installation.md#kubernetes) übernimmt der
Ingress-Controller HTTPS und leitet an den Service weiter. Es gelten
dieselben Regeln:

- `BASE_URL` in `deployment.yaml` muss der Host aus `ingress.yaml` sein, mit
  `https://`.
- `TRUST_PROXY` muss der Anzahl der Proxys vor der Anwendung entsprechen. Das
  Beispiel geht von einem aus: dem Ingress-Controller. Gibt ein Load Balancer
  oder CDN vor dem Controller die Client-Adresse ebenfalls in
  `X-Forwarded-For` weiter, erhöhst du den Wert für jeden davon um eins.
  Außerdem muss der Controller den eingehenden Header behalten
  (ingress-nginx: `use-forwarded-headers: "true"`), sonst ersetzt er ihn und
  die Anwendung sieht nur die Adresse des Load Balancers.
- Der Service ist nur im Cluster erreichbar; veröffentliche ihn nicht
  zusätzlich zum Ingress als `NodePort` oder `LoadBalancer`.
- Sammel-Uploads von Monitoring-Systemen können bis zu 5 MiB groß sein.
  ingress-nginx erlaubt standardmäßig 1 MiB; mit der Annotation
  `nginx.ingress.kubernetes.io/proxy-body-size: 6m` hebst du die Grenze an,
  wenn du große Pakete pushst.

## Öffentliche Seite einbetten

Die öffentlichen Seiten dürfen in andere Websites eingebettet werden, etwa in
dein Kundenportal:

```html
<iframe src="https://status.example.com/" title="Service-Status"
        style="width: 100%; height: 600px; border: 0"></iframe>
```

Verwaltung (`/admin`) und API (`/api/...`) senden
`X-Frame-Options: DENY` und `Content-Security-Policy: frame-ancestors 'none'`
und lassen sich nicht einbetten. Soll auch die öffentliche Seite nicht
eingebettet werden, lass deinen Proxy für alle übrigen Pfade
`Content-Security-Policy: frame-ancestors 'self'` setzen. Umgekehrt gilt:
Setze im Proxy keinen globalen `X-Frame-Options`-Header, wenn das Einbetten
funktionieren soll.

Weitere Möglichkeiten, den Status anderswo anzuzeigen:

- `GET /api/public/status`: kompakter, maschinenlesbarer Status als
  JSON:API-Dokument (Gesamtstatus, öffentliche Services, aktive Vorfälle und Wartungen).
- `/feed.rss` und `/feed.atom`: Vorfälle und Wartungen als Feed.

## Checkliste

- [ ] HTTPS funktioniert und HTTP leitet auf HTTPS um.
- [ ] `BASE_URL` stimmt genau mit der URL im Browser überein.
- [ ] `TRUST_PROXY` entspricht der Anzahl der Proxys vor der Anwendung.
- [ ] Der Port der Anwendung ist von außen nicht am Proxy vorbei erreichbar.
- [ ] Der Proxy erlaubt Request-Bodys von mindestens 5 MiB für
      `/api/ingest/`, wenn Monitoring-Systeme große Pakete senden.
