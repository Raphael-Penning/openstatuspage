# Security model of a split deployment

This page describes what protects the data of OpenStatusPage when the public
status page and the management side run as separate instances on PostgreSQL
(`APP_ROLE=public`, `admin`, `worker`, see
[configuration.md](configuration.md#split-deployment)). It covers what the
database role of the public instance can and cannot do, how that is enforced and
which attacks it is meant to contain.

A single instance with `APP_ROLE=all` (and every SQLite setup) has none of these
database-side boundaries: the application code is the only boundary there.

## Overview

```
 internet                         internal network / VPN
 ─────────                        ──────────────────────────────────────────────
 status.example.org               status.admin.example.org        worker
 APP_ROLE=public                  APP_ROLE=admin                  APP_ROLE=worker
 login: osp_public  ──┐           login: osp_app ──┐              login: osp_app ──┐
                      │                            │                               │
                      ▼                            ▼                               ▼
               ┌────────────────────────── PostgreSQL ─────────────────────────────┐
               │ schema osp_public          schema public (tables, owned by osp_app) │
               │  views of public rows ───► services, incidents, ... (RLS)           │
               │  functions (definer) ────► subscribers, subscriber_services, outbox │
               └────────────────────────────────────────────────────────────────────┘
                                                                     │
                                          monitoring systems, SMTP ◄─┘ (never the public instance)
```

The worker polls the monitoring systems and sends the mails. The admin instance
also connects to monitoring systems for manual actions ("poll now", connection
tests) and history imports. The public instance never connects to either.

- **Public instance**: serves the status page, the public API, feeds and the
  subscription endpoints. It connects with its own login role (`DB_PUBLIC_ROLE`,
  default `osp_public`), has no connection to monitoring systems or the SMTP
  server, and never runs migrations.
- **Admin and worker instances**: connect with the role that owns the tables
  (called `osp_app` here). They run the migrations, grant the public role its
  access on every start and do everything else. Their database access is **not**
  restricted beyond owning the tables (they also take advisory locks and write
  `task_leases` to share background work, see
  [architecture.md](architecture.md#several-instances)): protect them by network (internal only),
  login (OIDC, strong passwords) and by keeping the admin host off the internet.

## What the public role can do

| Access | How |
| --- | --- |
| Read public services, service groups and locations | views in `osp_public` |
| Read public incidents and maintenance with their updates, affected public services and public locations | views |
| Read the status history of public services and the history corrections that affect them (status and time range only) | views |
| Read the page settings (`settings` row `page`: site name, colors, which features are shown) | view |
| Read the applied schema version (`kysely_migration`) | view |
| Subscribe an address (double opt-in) | `osp_public.subscribe(...)` |
| Confirm, read, change and delete one subscription, **only with its token** | `osp_public.subscription_confirm/get/update/delete(...)` |
| Check whether its own login is restricted | `osp_public.connection_restricted()` |

The views have the same names as the tables, and the public instance connects
with `search_path=osp_public`, so the public code runs unchanged against them.
Server-side rendering of the public pages reads through the same code: the
render bundle gets the documents of `/api/public` in-process
(`apps/server/src/ssr/source.ts` → `services/public-documents.ts`), so a rendered
page and its embedded state block contain nothing the public API would not
return. The render bundle itself (`.ssr/`) is never served as a file. The
sitemaps and `llms.txt` (`routes/discovery.ts` → `services/site-index.ts`) read
the same views, with the same `is_public` filters on every other database; they
list only what the public pages show, and `robots.txt` keeps crawlers away
from `/api/`, `/admin` and the personal subscription links.

## What the public role cannot do

- **Read anything private.** It has no privilege at all on `users`, `sessions`,
  `api_tokens`, `audit_log`, `subscribers`, `subscriber_services`,
  `email_outbox`, `monitor_sources`, `monitor_checks`, `monitor_check_history`,
  `service_checks`, `check_bundles`, `check_bundle_members`, `history_imports`,
  `history_import_intervals`, `task_leases` and the role registry
  `osp_public_roles`.
- **Read hidden rows**: hidden services, groups, locations, incidents and
  maintenance, and everything linked only to them, are not in the views.
- **Read internal columns**: e.g. how a service status is made (`status_mode`,
  `manual_status`, `aggregation`, `monitor_status`), who created an incident,
  the internal `reason` of a history correction, unpublished correction notes,
  the notification flags of maintenance windows, any other settings row.
- **Write anything directly.** No `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on
  any table or view, no `CREATE` in the table schema or `osp_public`. With
  `deploy/postgres/harden.sql` (part of `roles.sql`) also no temporary tables
  and no large objects.
- **Block the background work.** `harden.sql` takes the advisory lock functions
  from `PUBLIC` and grants them only to the app role, so the public role cannot
  hold the lock keys with which admin and worker serialise status and bundle
  recomputes and history imports.
- **Call internal functions** such as `osp_grant_public_role`, or the helpers
  that queue mails.
- **Choose what a mail says.** The subscription functions queue confirmation and
  "manage" mails without content; the worker renders them from its own templates.
  The recipient is always the subscriber's stored address.
- **Use a subscription without its token.** The functions compare the SHA-256 of
  the given token with the stored hash (migration `0006`). The database never
  sees the token key and never hands out a salt except to the holder of a valid
  confirm token (who could derive the manage token anyway).

## How it is enforced

Migration `0007_public_role` (a no-op on SQLite) sets up four layers. Each would
stop a leak on its own; together they are defense in depth:

1. **Privileges.** `osp_grant_public_role(role)` first revokes everything from
   the role on the table schema, then grants `USAGE` on `osp_public`, `SELECT` on
   its views, `EXECUTE` on its functions, and column-level `SELECT` on exactly the
   public columns of the tables behind the views (most views are
   `security_invoker`, so they run with the rights of the public role). A column
   that a view blanks (the group id of a service in a hidden group, the note of a
   correction that is not shown) is never granted: the views of `services` and
   `status_corrections` run with the owner's rights instead, as
   `security_barrier` views, so reading the base table directly cannot skip the
   blanking. Admin and
   worker instances call it on every start (and `pnpm db:migrate` does), so the
   grants follow every migration. It refuses a role that is the connecting role,
   a superuser, has `BYPASSRLS` or is a member of any role (predefined roles such
   as `pg_read_all_data` would bypass the column privileges). Functions the
   migrating role creates are not executable by `PUBLIC` by default
   (`ALTER DEFAULT PRIVILEGES`), so a function added later is only callable by
   the roles it is granted to.
2. **Views.** The views select only public rows (`is_public = 1`, links whose
   both ends are public, the `page` settings row) and only public columns; hidden
   group ids and unpublished notes are blanked. Conditions of the caller (for
   example a cast whose error message would quote a value) are only evaluated on
   rows that passed the view's filter (`security_barrier`, or the RLS policies
   behind a `security_invoker` view).
3. **Row level security.** Every table has RLS enabled with a permissive
   `osp_access` policy (all other roles keep full access; the table owner
   bypasses RLS anyway) and a restrictive `osp_public_role` policy: for a role
   registered in `osp_public_roles` (current user or session user, so `SET ROLE`
   does not escape it) only public rows are visible and no row can be written.
   Tables without public data have no visible row at all. Even a privilege
   granted by mistake therefore exposes nothing hidden. The PostgreSQL tests
   check that every table (except Kysely's own) has these policies, so a table
   added by a later migration without them fails CI.
4. **Functions.** The only writes are `SECURITY DEFINER` functions owned by the
   table owner, with `search_path` pinned to the table schema and `pg_temp`
   (so objects the caller creates cannot hijack them). They validate every input
   themselves (address format and length, locale, ids, only existing public
   services, hash formats), check tokens, throttle mails like the application
   (one confirmation or manage mail per address per 10 minutes), never reveal
   whether an address is subscribed, and raise SQLSTATE `22023` for invalid input
   and `55000` while subscriptions are disabled.

`deploy/postgres/roles.sql` creates the login roles. It also sets a
`statement_timeout`, an idle-in-transaction timeout and a connection limit for
the public role, to bound what a compromised public instance can make the
database do, and runs `deploy/postgres/harden.sql`: it revokes from `PUBLIC`
the advisory lock functions (granted back to the app role), the functions that
create large objects and `TEMPORARY` on the database. Session advisory locks
outlive `statement_timeout`; without this a compromised public instance could
hold the application's lock keys and stall status recomputes, bundle evaluation
and history imports on every instance. These privileges exist per database and
also affect other applications in the same database. Rerun `roles.sql` on an
existing installation to apply it.

PostgreSQL 11 is the minimum and 15 or newer is recommended: older servers do not support
`security_invoker` views. There all views run with the owner's rights (as
`security_barrier` views); layers 1, 2 and 4 still apply, but RLS does not apply
through the views. The views of `services` and `status_corrections` work this
way on every version.

## Setting it up

1. Create the roles once (as a superuser, placeholders for the passwords):

   ```sh
   psql "postgres://postgres@db.example.org/openstatuspage" \
     -v public_password='<public password>' \
     -v app_password='<app password>' \
     -f deploy/postgres/roles.sql
   ```

   `-v public_role=<name>` and `-v app_role=<name>` change the names
   (defaults `osp_public` and `osp_app`). Leave out `app_password` to keep using
   an existing owner role for the admin and worker instances.

2. Admin and worker instances: `DATABASE_URL=postgres://osp_app:...@db/openstatuspage`
   and, if you changed it, `DB_PUBLIC_ROLE=<name>`. On start they migrate and log
   `public database role granted`. Their role needs `CREATE` on the database to
   create the schema `osp_public` (`roles.sql` grants it to `osp_app`). If it is
   missing, the migrations still succeed without that schema and the log says so.
   Grant the privilege and restart: the schema is created on the next start.
   Do not use a superuser here: the role that migrates owns the `SECURITY
   DEFINER` functions the public role calls, so they would run as superuser. The
   instance logs a warning when it migrates as one.

3. Public instance: `APP_ROLE=public` and
   `DATABASE_URL=postgres://osp_public:...@db/openstatuspage`. It waits for the
   schema, then checks its login: if it is **not** a registered public role (e.g.
   it was given the owner's credentials by mistake) it refuses to start with
   *"Refusing to start: the database login of this public instance is not a
   registered public role"*. `ALLOW_UNRESTRICTED_PUBLIC_DB=true` turns this into
   a warning, for setups that knowingly run without the database boundary.

All instances need the same `SUBSCRIPTION_TOKEN_KEY`: the public instance
derives the token hashes of new subscriptions and the manage token it returns on
confirmation from it, the worker the tokens in the mails. The public instance
gets **only** this key, not `SECRET_KEY` (which encrypts the monitoring
credentials and signs the OIDC state cookie of the admin instance); it logs a
warning when it gets `SECRET_KEY` anyway. When the token key changes, the admin
and worker instances refresh the stored hashes on their next start (existing
mail links stop working).

## HTML forms

The public pages work without JavaScript, so the email subscription also runs
through plain HTML forms (`apps/server/src/forms/`, every instance that serves
the public pages): `POST /subscribe`, `/subscription/confirm`,
`/subscription/manage` and `/subscription/unsubscribe` with
`application/x-www-form-urlencoded` bodies, next to the JSON:API (which they
leave unchanged). They call the same subscription flow, so a public instance on
PostgreSQL uses the `osp_public` functions above, and they have the same rate
limits per client IP (5 subscribe requests, 30 confirm, manage and unsubscribe
requests per minute; the forms and the API count separately).

- **Cross-site requests.** The forms carry no cookie (the public role sets
  none), but another site could still make a visitor's browser post one, for
  example to subscribe an address. Browsers say where a request comes from:
  a form handler accepts it only with `Sec-Fetch-Site: same-origin`, or, from
  browsers without that header, with an `Origin` of the request's own origin or
  of `PUBLIC_BASE_URL`; anything else gets `403`. A request without either header
  does not come from a browser page and cannot be forged through one. The same
  check guards the theme form (`POST /preferences/theme`); the language links
  (`GET /preferences/language`) set no cookie for requests from other sites.
- **Tokens in links.** For the confirm and manage pages to work without
  JavaScript, the server has to see the token, so the links in the emails carry
  it in the query string (`?id=…&token=…`) instead of the URL fragment, and the
  forms send it in the body. The server's request log redacts every `token=`
  value, `/subscription/*` answers with `Referrer-Policy: no-referrer` and
  `Cache-Control: private, no-store`, and these pages are never kept in the
  render cache. A reverse proxy that logs full URLs does see the token: keep its
  access log private or strip query strings from it. A leaked manage token lets
  someone change or end that one subscription, nothing else; confirming takes a
  click on a form, so a mail scanner that opens the link confirms nothing.
- **Open redirects.** The preference handlers redirect only to a path of the
  site (`/…`, no `//`, no scheme, no control characters), everything else to `/`.

## Threat model

### A compromised public instance

An attacker runs code on the public host (vulnerable dependency, remote code
execution) and holds its environment: the public database login and
`SUBSCRIPTION_TOKEN_KEY`.

- **Contained**: the attacker reads nothing the public page does not already
  show. Subscriber addresses, users, password hashes, sessions, API tokens,
  monitoring credentials and hosts, ingest token hashes, audit entries and
  internal notes stay out of reach. The attacker can neither change the status
  page nor delete data, and cannot reach the monitoring systems (no route,
  no credentials) or send mail with own content.
- **Not contained**:
  - The attacker can serve a fake status page or alter answers of the public
    instance itself.
  - With `SUBSCRIPTION_TOKEN_KEY` the attacker can derive the links of every
    subscriber whose id and salt it learns; it learns them only from the
    subscribers who use the instance while it is compromised (their address and
    tokens pass through it). It can subscribe addresses and, from the hashes it
    chooses for new subscribers, confirm them; mails still only go to the given
    address and are throttled. Rotate the token key (and the public role's
    password) after a compromise.
  - The public host never holds `SECRET_KEY`: the monitoring credentials stay
    encrypted with a key it does not have, and it cannot forge the signed OIDC
    state cookie of the admin instance.
  - Denial of service against the database is bounded by the role's timeouts and
    connection limit, not prevented. It cannot take the advisory locks of the
    background work (`harden.sql`).

### SQL injection in the public code

The public code uses Kysely with bound parameters, so injection is not expected;
if it happened, the injected SQL runs as the public role. It is then limited
exactly as above: the views, functions and RLS policies are the boundary, not
the query that was injected. Hidden rows and private tables stay unreadable, and
direct writes fail. The functions themselves validate their arguments and use
no dynamic SQL.

### A compromised admin account

An attacker logs in to the management UI (stolen password, phished OIDC
account) or obtains an API token.

- The admin side is built to manage everything: within that account's role
  (admin or editor) the attacker can edit the page and, as admin, see the
  subscriber list and the monitoring settings. The database does not limit an
  admin account; the role checks of the admin API do.
- **Contained by the split**: the public instance offers no login, no admin API
  and no ingest route (404), so admin accounts cannot be used or brute-forced
  from the internet when the admin host is internal. Whatever the attacker makes
  public flows out only through the views, i.e. as public status page content;
  there is no path to make the public instance hand out private tables.
- Keep the admin host off the internet (VPN, IP allow list), use OIDC with
  group mapping, and review the audit log.

### A compromised admin or worker instance

Their login owns the tables, so the database does not restrict them. Run them in
an internal network only, keep their credentials (database, `SECRET_KEY`,
monitoring credentials, SMTP) out of the public host, and patch them like any
internal service.

## Verification

`apps/server/test-pg/public-role.test.ts` connects **as** the public role and
checks every statement of this page: the views return only public data, private
tables and internal columns are not readable, every direct write and every call
of an internal function fails, and the subscription functions work and reject
invalid input, also through a public instance end to end. CI runs it in the
`postgres` job:

```sh
psql "$DATABASE_URL" -v public_password=... -f deploy/postgres/roles.sql
PG_TEST_URL=postgres://owner:...@localhost:5432/osp \
PG_TEST_PUBLIC_URL=postgres://osp_public:...@localhost:5432/osp \
  pnpm --filter @openstatuspage/server test:pg
```

`PG_TEST_URL` needs the right to create databases (each test file uses a fresh
one and drops it afterwards).
