# Security checklist

Go through this list before going live and after larger changes.

## Server and network

- [ ] The app is only reachable through a reverse proxy with HTTPS; the app
      port (3000) is bound to localhost or a private network.
- [ ] `BASE_URL` starts with `https://`, so session cookies are marked
      `Secure`.
- [ ] `TRUST_PROXY` equals the number of proxies in front of the app, never
      more.
- [ ] The host, Docker and the base images receive security updates; the app
      is rebuilt regularly (`docker compose ... up -d --build`).
- [ ] Only the proxy ports (80/443) are open to the internet. PostgreSQL is
      not published.

## Secrets

- [ ] `SECRET_KEY` is random (`openssl rand -base64 48`), unique per
      installation and stored safely outside the server as well.
- [ ] `POSTGRES_PASSWORD`, `SMTP_PASSWORD` and the OIDC client secret are
      random and not reused elsewhere.
- [ ] Environment files are readable only by root or the service user
      (`chmod 600`) and not committed to any repository.
- [ ] `ADMIN_PASSWORD` was removed from the environment after the first start.

## Accounts and access

- [ ] Every person has their own account; nobody shares the initial admin.
- [ ] Few administrators; everybody who only communicates incidents is an
      editor.
- [ ] Former team members are deleted (their API tokens are revoked with
      them).
- [ ] With single sign-on: `OIDC_ADMIN_GROUP` / `OIDC_EDITOR_GROUP` are set,
      `OIDC_AUTO_CREATE_USERS` is only enabled together with them, and the
      issuer is your own tenant, never a public multi-tenant endpoint.
- [ ] Consider `LOCAL_LOGIN_ENABLED=false` once single sign-on works for at
      least one administrator.
- [ ] API tokens have the smallest role that works, descriptive names, and
      unused tokens are revoked.
- [ ] The audit log is reviewed now and then.

## Monitoring integration

- [ ] Push is used where the status page is reachable from the internet, so
      no monitoring credentials are stored on it.
- [ ] Pull credentials belong to a dedicated read-only user restricted to the
      relevant objects.
- [ ] TLS verification is enabled for all sources; internal CAs are added
      with `NODE_EXTRA_CA_CERTS`.
- [ ] Ingest tokens are sent in the `Authorization` header where possible and
      are rotated when they may have leaked.

## Public content

- [ ] Service names, descriptions, incident texts and maintenance texts
      contain no internal host names, IP addresses or system names.
- [ ] Services, groups and locations that must not be public are marked
      hidden.
- [ ] Footer links point to your imprint and privacy policy.
- [ ] If the page must not be embedded elsewhere, the proxy sends
      `Content-Security-Policy: frame-ancestors 'self'`.

## Email

- [ ] SMTP uses TLS (`SMTP_SECURE=true` or STARTTLS);
      `SMTP_TLS_REJECT_UNAUTHORIZED` stays `true`.
- [ ] SPF, DKIM and DMARC are set up for the sender domain.
- [ ] The privacy policy describes email subscriptions (purpose, storage,
      unsubscribing).

## Operations

- [ ] Backups of the database run automatically, are stored off-host and a
      restore was tested.
- [ ] `SECRET_KEY` is backed up separately from the database.
- [ ] The status page is monitored from outside your infrastructure.
- [ ] Only one instance runs the background worker.
