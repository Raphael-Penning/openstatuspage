# Troubleshooting

Start with the logs (`docker compose logs -f openstatuspage` in the directory
with `compose.yaml`, on Kubernetes
`kubectl -n openstatuspage logs deployment/openstatuspage`) and
`GET /api/health`. Set `LOG_LEVEL=debug` temporarily for more detail.

## Container image

**`docker compose pull` or `docker pull` fails with "manifest unknown" or
"not found".**
The tag does not exist. Check `OSP_VERSION` (`1.2.3`, without `v`).
`latest` and the version tags only exist after the first release; until
then use `edge` or a `sha-` tag. The available tags are listed on the
package page of the repository on GitHub. On Kubernetes the pod shows
`ErrImagePull` / `ImagePullBackOff`; `kubectl -n openstatuspage describe pod`
shows the message.

**The pull fails with "denied" or "unauthorized".**
The package is private. New packages on the GitHub Container Registry often
start private (for example on a fork). Make it public in the package
settings, or log in with a token that may read packages:
`docker login ghcr.io` (on Kubernetes an `imagePullSecret`). An expired
login in `~/.docker/config.json` causes the same error for public images;
`docker logout ghcr.io` fixes it.

**"no matching manifest for linux/arm/v7" or "exec format error".**
Images are published for `linux/amd64` and `linux/arm64` only. On other
platforms [build the image yourself](02-installation.md#building-the-image-yourself).

**After a restart a different version runs.**
`OSP_VERSION` is a moving tag (`latest`, `1.2`) and a newer image was pulled.
Pin a release, see [Image tags](02-installation.md#image-tags).

## Start-up

**The container restarts with "Invalid configuration".**
The message lists every invalid variable, e.g. `BASE_URL: Invalid URL` or
`ADMIN_PASSWORD: Too small: expected string to have >=10 characters`. `BASE_URL` needs the scheme (`https://`),
`ADMIN_PASSWORD` at least 10 characters, `SECRET_KEY` at least 32.

**"SECRET_KEY must be set".**
In production (the default `NODE_ENV`) the key is mandatory. Generate one with
`openssl rand -base64 48`.

**"SECRET_KEY: is a published example value".**
The key (or `SUBSCRIPTION_TOKEN_KEY`) is still the value from the
documentation or an example file. Generate your own with
`openssl rand -base64 48`. On an existing installation this makes stored
monitoring credentials unreadable, so re-enter them afterwards.

**PostgreSQL warning: "the public database role ... may still create objects
in the table schema or in osp_public".**
Updates take `CREATE` on the table schema away from the public role and from
`PUBLIC` by themselves (PostgreSQL before version 15, and clusters upgraded from
one, let everybody create objects in schema `public`). This warning means the
role that runs the migrations was not allowed to, usually because a superuser
owns the schema; on PostgreSQL 14 or older that is the normal case. Everything
keeps running, and such objects cannot take over the functions of the public
role. The public role can still break them, though, so close it: run the
command from the warning once as a superuser (or the schema owner) in that
database, typically `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`. If the
warning starts with `GRANT CREATE ON SCHEMA public TO <app role>;`, run that
part too, first: the app role needs it for later updates. Rerunning
`deploy/postgres/harden.sql` as a superuser is the same only when the warning
does not start with that `GRANT`; otherwise run the `GRANT` first (or rerun
`deploy/postgres/roles.sql`, which grants it). The warning appears on every
start until then and disappears on the next start after. The public instance
logs a matching warning ("may create objects in the table schema") with the
same cause.

0.3.0 refused to start in this situation (*"The public database role ... may
create objects in the schema ..."*); a later version starts without any manual
step.

**`docker compose` says "set SECRET_KEY in .env" or "set POSTGRES_PASSWORD
in .env".**
The variable is missing or empty in `.env`. On a new installation append both
with the `printf` line from [Installation](02-installation.md#install). On an
existing installation restore the old values from your backup instead of
generating new ones: a new `SECRET_KEY` makes stored monitoring credentials
unreadable, and a new `POSTGRES_PASSWORD` does not match the existing
database.

**`docker compose` says "no configuration file provided", "env file ...
not found" or "set SECRET_KEY in .env".**
The command runs in the wrong directory, or `.env` does not exist yet
(without it Compose stops at the first required variable). Change
into the directory with `compose.yaml` and `.env` (in a clone:
`deploy/compose`) and create `.env` as described in
[Installation](02-installation.md#install).

**A value from `.env` arrives shortened, or Compose warns "The ... variable
is not set".**
Compose interprets `$` in `.env`: `pa$word` becomes `pa`. Wrap the whole value
in single quotes (`SMTP_PASSWORD='pa$word'`) and run `docker compose up -d`.

**A change in `.env` has no effect.**
Run `docker compose up -d`; `docker compose restart` keeps the old
environment. `docker compose exec openstatuspage env` shows what the
container received. `DATABASE_URL` is always set by `compose.yaml`.

**After switching to `compose.yaml` the installation is empty.**
The new file uses a different project name and therefore new volumes. See
[Moving from the 0.1.0 compose file](09-operations.md#moving-from-the-010-compose-file).

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
role for the existing user, signs them out everywhere and revokes the API
tokens they created.

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
token (rotated?), `404` wrong source ID, `409` source disabled or full sync
rejected because it would remove most linked checks, `413` request too large
for the reverse proxy, `429` more than 120 requests per minute. The reason is
in `errors[0].detail` of the answer (`source.pointer` names the field of an
invalid payload, e.g. `/checks/0/state`).
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

When you report a problem, include the version (image tag, or the Git commit
when you build yourself), the deployment method, the relevant log lines and
the steps to reproduce it. Remove secrets, host names and email addresses
first.
