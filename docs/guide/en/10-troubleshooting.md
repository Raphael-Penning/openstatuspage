# Troubleshooting

Start with the logs (`docker compose -f docker/docker-compose.yml logs -f openstatuspage`)
and `GET /api/health`. Set `LOG_LEVEL=debug` temporarily for more detail.

## Start-up

**The container restarts with "Invalid configuration".**
The message lists every invalid variable, e.g. `BASE_URL: Invalid URL` or
`ADMIN_PASSWORD: Too small: expected string to have >=10 characters`. `BASE_URL` needs the scheme (`https://`),
`ADMIN_PASSWORD` at least 10 characters, `SECRET_KEY` at least 32.

**"SECRET_KEY must be set".**
In production (the default `NODE_ENV`) the key is mandatory. Generate one with
`openssl rand -base64 48`.

**`docker compose` says "set SECRET_KEY" or "set POSTGRES_PASSWORD".**
The variables are not set in the shell or the `--env-file` you used. Compose
needs them on every `up`, not only the first.

**"DATABASE_URL must start with sqlite: or postgres://".**
Use `sqlite:/path/to/file.db` or `postgres://user:password@host:5432/db`.
Special characters in the password must be URL-encoded.

**The log warns "no users exist".**
Neither `ADMIN_EMAIL`/`ADMIN_PASSWORD` were set on the first start nor was a
user created. Use the `create-user` command, see
[Installation](02-installation.md#the-first-administrator).

## Login

**I forgot the administrator password.**
Run `create-user` with the same email address: it sets a new password and
role for the existing user and signs them out everywhere.

**I am logged out right after logging in, or the login does not stick.**
`BASE_URL` starts with `https://` but the page is opened via `http://`: the
session cookie is then only sent over HTTPS. Open the page via the URL in
`BASE_URL`.

**"Too many requests" on the login page, for everybody.**
Behind a reverse proxy without `TRUST_PROXY`, all users share the proxy's IP
and its rate limit. Set `TRUST_PROXY` (see
[Reverse proxy](03-reverse-proxy.md#trust_proxy)).

**SSO fails with an error code on the login page.**
The codes (`oidc_unavailable`, `forbidden`, `no_account`,
`email_not_verified`, ...) are explained in [`docs/oidc.md`](../../oidc.md).
The most common causes: the redirect URI at the identity provider does not
exactly match `${BASE_URL}/api/auth/oidc/callback`, the issuer URL is not
reachable from the server, or the groups claim is missing in the token.

## Monitoring

**A pull source shows an error.**
The error text is on the source. Typical: wrong base URL, missing
permissions of the API user, TLS certificate not trusted (set
`NODE_EXTRA_CA_CERTS` instead of disabling verification), firewall between
the status page and the monitoring API. "Test connection" checks without
storing anything.

**Pushed results do not arrive.**
Call the ingest URL by hand with `curl` and look at the answer: `401` wrong
token (rotated?), `404` wrong source ID, `409` source disabled, `413` request
too large for the reverse proxy, `429` more than 120 requests per minute.
Run the notification scripts with `OSP_DRY_RUN=1` to see the payload.

**A service stays operational although a check is critical.**
Check that the service's status source is *Automatic*, that the check is
linked, and how the link maps *Critical* (it may be set to "Ignore"). With
*Redundancy (quorum)*, a single failing check only causes a partial outage.
A maintenance in progress shows *Maintenance* instead.

**After stored credentials suddenly fail, every pull source has errors.**
`SECRET_KEY` was changed. Re-enter the credentials of every source, see
[Operations](09-operations.md#secret_key).

## Public page

**A service, incident or maintenance does not appear.**
Check that it is marked *Visible on the public status page*. Services of a
hidden group are shown without group. Upcoming maintenance appears only
until its scheduled end.

**The maintenance did not start or complete automatically.**
No instance runs the worker (`WORKER_ENABLED=false` everywhere), or
*Start automatically* / *Complete automatically* are off. Transitions happen
within 30 seconds of the scheduled time.

**Changes appear with a delay.**
Public API responses may be cached for 30 seconds by browsers and proxies.

**The page cannot be embedded in an iframe.**
Your proxy adds `X-Frame-Options` or a `frame-ancestors` policy. See
[Reverse proxy](03-reverse-proxy.md#embedding-the-public-page).

**Links in feeds or emails point to `localhost`.**
`BASE_URL` is not set to the public URL.

## Email

See the troubleshooting table in
[Email subscriptions](07-email-subscriptions.md#troubleshooting).

## Getting help

When you report a problem, include the version (Git commit), the deployment
method, the relevant log lines and the steps to reproduce it. Remove secrets,
host names and email addresses first.
