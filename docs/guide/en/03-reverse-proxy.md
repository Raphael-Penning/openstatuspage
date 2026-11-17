# Reverse proxy and HTTPS

OpenStatusPage speaks plain HTTP. In production put a reverse proxy in front of
it that terminates HTTPS. Three things must fit together:

1. The proxy forwards to the app (port 3000 by default) and sets the
   `X-Forwarded-*` headers.
2. `BASE_URL` is the exact public URL, e.g. `https://status.example.com`.
3. `TRUST_PROXY` tells the app how many proxies to trust, so it sees the real
   client IP.

Publish the app port on localhost only (`HOST_PORT=127.0.0.1:3000` with
Docker Compose, `HOST=127.0.0.1` from source) when the proxy runs on the same
host, so nobody can bypass the proxy.

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

## Caddy

Caddy obtains certificates automatically and sets the forwarding headers by
default.

```caddyfile
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Configuration: `BASE_URL=https://status.example.com`, `TRUST_PROXY=1`.

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

With Traefik as a Docker container in the same network, add labels to the
`openstatuspage` service in the compose file (and drop the `ports:` mapping,
Traefik reaches the container directly):

```yaml
services:
  openstatuspage:
    # ... as in docker/docker-compose.yml
    environment:
      BASE_URL: https://status.example.com
      TRUST_PROXY: "1"
      # ...
    labels:
      - traefik.enable=true
      - traefik.http.routers.openstatuspage.rule=Host(`status.example.com`)
      - traefik.http.routers.openstatuspage.entrypoints=websecure
      - traefik.http.routers.openstatuspage.tls.certresolver=letsencrypt
      - traefik.http.services.openstatuspage.loadbalancer.server.port=3000
```

The entry point (`websecure`) and the certificate resolver (`letsencrypt`)
are the names from your Traefik static configuration. The container must be
in a network Traefik is attached to.

## Embedding the public page

The public pages may be embedded in other websites, for example in your
customer portal:

```html
<iframe src="https://status.example.com/" title="Service status"
        style="width: 100%; height: 600px; border: 0"></iframe>
```

The management UI (`/admin`) and the API (`/api/...`) send
`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
and cannot be framed. If you do not want the public page to be embedded
either, let your proxy add `Content-Security-Policy: frame-ancestors 'self'`
for all other paths. Conversely, do not add a global `X-Frame-Options`
header in the proxy if you want embedding to work.

Other ways to show the status elsewhere:

- `GET /api/public/status.json`: compact machine-readable status (overall
  status, public services, active incidents and maintenance).
- `/feed.rss` and `/feed.atom`: incidents and maintenance as feeds.

## Checklist

- [ ] HTTPS works and HTTP redirects to HTTPS.
- [ ] `BASE_URL` matches the URL in the browser exactly.
- [ ] `TRUST_PROXY` equals the number of proxies in front of the app.
- [ ] The app port is not reachable from outside without the proxy.
- [ ] The proxy allows request bodies of at least 5 MiB for `/api/ingest/`
      when monitoring systems push large batches.
