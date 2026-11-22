# Reverse proxy and HTTPS

OpenStatusPage speaks plain HTTP. In production put a reverse proxy in front of
it that terminates HTTPS. Three things must fit together:

1. The proxy forwards to the app (port 3000 by default) and sets the
   `X-Forwarded-*` headers.
2. `BASE_URL` is the exact public URL, e.g. `https://status.example.com`.
3. `TRUST_PROXY` tells the app how many proxies to trust, so it sees the real
   client IP.

Publish the app port on localhost only (`HOST_PORT=127.0.0.1:3000` in
`.env` with Docker Compose, the default there; `-p 127.0.0.1:3000:3000` with
a single container, `HOST=127.0.0.1` from source) when the proxy runs on the
same host, so nobody can bypass the proxy. On Kubernetes the
[ingress](#kubernetes-ingress) takes the role of the proxy.

With Docker Compose `BASE_URL`, `TRUST_PROXY` and `HOST_PORT` go into `.env`
next to `compose.yaml` (see
[Installation](02-installation.md#settings-in-env)); the template already
contains `TRUST_PROXY=1`. Apply changes with `docker compose up -d`.

## BASE_URL

`BASE_URL` is used for:

- links in RSS/Atom feeds and in notification emails,
- the OIDC redirect URI `${BASE_URL}/api/auth/oidc/callback`,
- the ingest URLs shown for monitoring sources,
- the `Secure` flag of cookies: when `BASE_URL` starts with `https://`, the
  session cookie is only sent over HTTPS.

Use the URL your users type into the browser, without a trailing slash and
without a path. Serving the app under a sub-path (e.g.
`https://example.com/status/`) is not supported; use a dedicated host name.

## TRUST_PROXY

Behind a proxy every request arrives from the proxy's address. The app needs
the client IP for rate limiting (login, subscriptions) and session metadata,
and takes it from `X-Forwarded-For` only as far as you allow:

| Value | Meaning |
| --- | --- |
| `false` (default) | No proxy. The TCP peer is the client. Behind a proxy all clients then share one IP and one rate limit. |
| `1` or `true` | Exactly one proxy in front of the app (the usual case). |
| `2`, `3`, ... | That many proxies in a chain, e.g. a CDN or load balancer in front of your proxy. |
| `10.0.0.0/8,127.0.0.1` | Trust only proxies with these addresses / networks. |

`true` means one hop, never "trust everything". Set the value to exactly the
number of proxies you operate: entries further left in `X-Forwarded-For` come
from the client and can be forged. A value that is too high lets clients
choose their own IP and bypass rate limits.

A hop count trusts whoever connects to the app. It is only safe while the app
port is reachable through the proxy alone (published on localhost, or only
inside a private network). If the port is reachable from other hosts, set
`TRUST_PROXY` to the proxy's addresses or networks instead (e.g.
`TRUST_PROXY=192.0.2.10` or `TRUST_PROXY=10.0.0.0/8`), so a client that
bypasses the proxy cannot set its own `X-Forwarded-For`.

The address must be the one the app sees as the peer of the connection, which
is not always the proxy's own address. When the proxy connects through a port
published by Docker's userland proxy (rootless Docker, Docker Desktop, or a
proxy on the same host), the app sees the gateway of the Docker network (e.g.
`172.17.0.1`). Check the client address in the request log and, in that case,
list the gateway or subnet of the Docker network.

## Caddy

Caddy obtains certificates automatically and sets the forwarding headers by
default.

```caddyfile
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Configuration: `BASE_URL=https://status.example.com`, `TRUST_PROXY=1`.

### Caddy in the compose setup

Caddy can also run as a third service next to the app. Create two files next
to `compose.yaml`:

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

In `.env` set `BASE_URL=https://status.example.com`, `TRUST_PROXY=1` and
`HOST_PORT=127.0.0.1:3000`: Caddy reaches the app over the compose network,
and the published port stays on localhost for your own checks. Start
everything with both files:

```bash
docker compose -f compose.yaml -f compose.caddy.yaml up -d
```

Pass both files to every later command, or add
`COMPOSE_FILE=compose.yaml:compose.caddy.yaml` to `.env`; then plain
`docker compose ...` commands include Caddy.

The DNS name must point to the host and ports 80 and 443 must be reachable
from the internet, so Caddy can obtain the certificate. The volume
`caddy_data` keeps the certificates; do not delete it.

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

    # Bulk check uploads from monitoring systems may be up to 5 MiB.
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

Configuration: `BASE_URL=https://status.example.com`, `TRUST_PROXY=1`.
Certificates can be obtained with certbot or any other ACME client.

## Traefik

With Traefik as a Docker container, add labels to the `openstatuspage`
service in an override file next to `compose.yaml`. Traefik reaches the
container directly, so keep `HOST_PORT=127.0.0.1:3000` (or any other port
bound to localhost):

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

Set `BASE_URL=https://status.example.com` and `TRUST_PROXY=1` in `.env` and
start with `docker compose -f compose.yaml -f compose.traefik.yaml up -d`
(or `COMPOSE_FILE=compose.yaml:compose.traefik.yaml` in `.env`). The entry
point (`websecure`) and the certificate resolver (`letsencrypt`) are the
names from your Traefik static configuration. The container must be in a
network Traefik is attached to (add it under `networks:` in the override file
if Traefik runs in a different compose project).

## Kubernetes ingress

With the [Kubernetes manifests](02-installation.md#kubernetes) the ingress
controller terminates HTTPS and forwards to the service. The same rules
apply:

- `BASE_URL` in `deployment.yaml` must be the host from `ingress.yaml`, with
  `https://`. The [Helm chart](02-installation.md#kubernetes-with-helm) derives
  the Ingress host from `baseUrl` and sets `config.TRUST_PROXY` to 1 by default.
- `TRUST_PROXY` must equal the number of proxies in front of the app. The
  example assumes one: the ingress controller. If a load balancer or CDN in
  front of the controller passes the client address on in
  `X-Forwarded-For` as well, increase the value by one for each of them, and
  configure the controller to keep the incoming header (ingress-nginx:
  `use-forwarded-headers: "true"`); otherwise it replaces the header and the
  app only sees the load balancer's address.
- The service is only reachable inside the cluster; do not expose it as
  `NodePort` or `LoadBalancer` in addition to the ingress.
- Bulk uploads from monitoring systems may be up to 5 MiB. ingress-nginx
  allows 1 MiB by default; raise it with the annotation
  `nginx.ingress.kubernetes.io/proxy-body-size: 6m` if you push large
  batches.

## Embedding the public page

The public pages may be embedded in other websites, for example in your
customer portal:

```html
<iframe src="https://status.example.com/" title="Service status"
        style="width: 100%; height: 600px; border: 0"></iframe>
```

The management UI (`/admin`), the API (`/api/...`), private pages (`/p/...`)
and the subscription confirm and manage pages (`/subscription/...`) send
`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
and cannot be framed. If you do not want the public page to be embedded
either, let your proxy add a second header `Content-Security-Policy:
frame-ancestors 'self'` for all other paths (browsers enforce both policies). Conversely, do not add a global `X-Frame-Options`
header in the proxy if you want embedding to work.

Other ways to show the status elsewhere:

- `GET /api/public/status`: compact machine-readable status as a JSON:API
  document (overall status, public services, active incidents and maintenance).
- `/feed.rss` and `/feed.atom`: incidents and maintenance as feeds.
- `/llms.txt` and `/llms-full.txt`: the page and its current status as
  Markdown for AI assistants and agents.

Search engines find the public pages through `/robots.txt` and `/sitemap.xml`.
All links in them use `PUBLIC_BASE_URL` (or `BASE_URL`), so it must be the
address visitors use. Pass these paths through the proxy unchanged, and keep
the `X-Robots-Tag` header the app sends for `/admin`.

## Compression, caching and security headers

The app already compresses its responses: the files of the web client are
stored as Brotli and gzip copies, and pages are sent gzip-compressed. Caching
headers are set as well (one year for the hashed files in `/assets/`). The proxy
can pass all of this through; compressing again gains nothing. Pages carry a
Content-Security-Policy, `Cross-Origin-Opener-Policy` and `Permissions-Policy`
(see [performance](../../performance.md)). Add `Strict-Transport-Security` in
the proxy once the site is served only over HTTPS.

Keep these headers exactly as the app sends them:

- **`Vary` and `Content-Encoding`.** The app sends `Vary: Accept-Encoding` with
  every compressed file, and `Vary: Accept-Language, Cookie, Accept-Encoding` with
  every page, because the same address has a different answer for each language,
  cookie and encoding. Do not strip these headers, and do not let a cache ignore
  `Vary`. A cache that serves a Brotli copy to a client that only accepts gzip
  breaks the page.
- **`Accept-Encoding` and `Accept-Language`.** Pass the request headers to the app
  unchanged. Do not remove them or set them to an empty value for the upstream;
  the app picks the precompressed copy and the language from them.
- **Do not compress twice.** Responses that already carry `Content-Encoding` must
  pass through untouched. A compression module in the proxy is fine for other
  responses, such as the JSON API, but it must skip what the app has compressed.
- **Cache headers.** Keep the app's `Cache-Control`. Files in `/assets/` are cached
  for a year (`immutable`), other static files for a day, pages for 10 seconds
  with `stale-while-revalidate`. Keep the `ETag`, so that unchanged pages answer
  `304 Not Modified`. Do not add caching of your own to `/admin` or `/api/`. The
  personal subscription links (`/subscription/`, `/preferences/`) are answered
  with `private, no-store`; the proxy must not store them either.

## Checklist

- [ ] HTTPS works and HTTP redirects to HTTPS.
- [ ] `BASE_URL` matches the URL in the browser exactly.
- [ ] `TRUST_PROXY` equals the number of proxies in front of the app.
- [ ] The app port is not reachable from outside without the proxy.
- [ ] The proxy allows request bodies of at least 5 MiB for `/api/ingest/`
      when monitoring systems push large batches.
