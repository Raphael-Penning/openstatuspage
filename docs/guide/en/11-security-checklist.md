# Security checklist

Go through this list before going live and after larger changes.

## Server and network

- [ ] The app is only reachable through a reverse proxy with HTTPS; the app
      port (3000) is bound to localhost or a private network.
- [ ] `BASE_URL` starts with `https://`, so session cookies are marked
      `Secure`.
- [ ] `TRUST_PROXY` equals the number of proxies in front of the app, never
      more.
- [ ] The host, Docker and the cluster receive security updates.
- [ ] The image is pinned to a release (`OSP_VERSION=1.2.3`, `newTag` in
      Kubernetes), optionally to its digest, and never `edge` in
      production.
- [ ] New releases are installed regularly (they also contain updated base
      images and dependencies); someone watches the releases of the
      repository. If you build the image yourself, rebuild it regularly.
- [ ] Images come only from `ghcr.io/raphael-penning/openstatuspage`, your
      own build or a mirror you control.
- [ ] Only the proxy ports (80/443) are open to the internet. PostgreSQL is
      not published.

## Secrets

- [ ] `SECRET_KEY` is random (`openssl rand -base64 48`), unique per
      installation and stored safely outside the server as well.
- [ ] `POSTGRES_PASSWORD`, `SMTP_PASSWORD` and the OIDC client secret are
      random and not reused elsewhere.
- [ ] `.env` (and any other environment file) is readable only by root or
      the service user (`chmod 600`) and not committed to any repository.
- [ ] A copy of `.env`, or at least `SECRET_KEY` and `POSTGRES_PASSWORD`, is
      kept in a safe place outside the server.
- [ ] On Kubernetes the secret `openstatuspage` is created with `kubectl` or
      a secret manager, never stored in plain text in Git, and only few
      people may read secrets in the namespace.
- [ ] `ADMIN_PASSWORD` was removed from the environment after the first start.

## Kubernetes

- [ ] The security context of `deployment.yaml` is kept as shipped: non-root
      user 1000, no privilege escalation, all capabilities dropped,
      read-only root file system, `RuntimeDefault` seccomp profile.
- [ ] Only the ingress is exposed; the service stays `ClusterIP`.
- [ ] One replica, or several only as described in
      [Running several instances](09-operations.md#running-several-instances).
- [ ] The database is not reachable from outside the cluster or the
      database network.

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

- [ ] SMTP uses TLS: `SMTP_SECURE=true`, or a server that offers STARTTLS
      (with `SMTP_SECURE=false` STARTTLS is used only when the server offers
      it); `SMTP_TLS_REJECT_UNAUTHORIZED` stays `true`.
- [ ] SPF, DKIM and DMARC are set up for the sender domain.
- [ ] The privacy policy describes email subscriptions (purpose, storage,
      unsubscribing) and is linked in the footer.
- [ ] `MAIL_TRANSPORT=log` is not used in production: the server log would
      contain the confirmation and manage links.

## Operations

- [ ] Backups of the database run automatically, are stored off-host and a
      restore was tested.
- [ ] `SECRET_KEY` is backed up separately from the database.
- [ ] The status page is monitored from outside your infrastructure.
- [ ] Only one instance runs the background worker.
