# Reverse proxy templates

Templates for a reverse proxy on the same host as OpenStatusPage, for the
installation without containers (`scripts/install.sh`, the `.deb`/`.rpm`
packages) and for Compose with the default `HOST_PORT=127.0.0.1:3000`.

| File | Proxy | Deployment |
| --- | --- | --- |
| `Caddyfile` | Caddy (automatic TLS) | one instance (`APP_ROLE=all`), port 3000 |
| `Caddyfile.split` | Caddy (automatic TLS) | split: public 3000, admin 3001 |
| `nginx.conf` | nginx (TLS from certbot or another ACME client) | one instance, port 3000 |
| `nginx.split.conf` | nginx | split: public 3000, admin 3001 |

All of them assume that the app listens on `127.0.0.1` only (`HOST=127.0.0.1`,
or the default `HOST_PORT` of Compose) and set `TRUST_PROXY=1`: one proxy hop,
which is safe only while nobody can reach the app port around the proxy. If
the proxy runs on another host, let the app listen on its private address and
set `TRUST_PROXY` to the proxy's address instead of a hop count.

Replace `status.example.com`, `status.admin.example.com`, the certificate
paths and the allowed networks of the admin domain (`192.0.2.0/24` and
`2001:db8::/32` are documentation ranges). Details, Traefik and Kubernetes:
[docs/guide/en/03-reverse-proxy.md](../../docs/guide/en/03-reverse-proxy.md).
