# Single sign-on with OpenID Connect

The management UI supports login through any OpenID Connect provider
(Keycloak, Authentik, Microsoft Entra ID, Okta, Zitadel, Dex, ...). The public
status page never requires a login.

## How it works

1. The login page shows an SSO button (`OIDC_LABEL`) when OIDC is configured.
2. `GET /api/auth/oidc/login` redirects to the IdP using the
   **authorization code flow with PKCE** (S256). The PKCE verifier, `state` and
   `nonce` are kept in a signed, http-only cookie that expires after 10 minutes.
3. The IdP redirects back to `GET /api/auth/oidc/callback`. The server exchanges
   the code, validates the ID token (signature, issuer, audience, nonce) and
   reads the claims. Missing claims (e.g. groups) are taken from the userinfo
   endpoint when the IdP offers one.
4. The user is mapped to a local account and gets a normal session cookie.
   On errors the browser is sent to `/admin/login?error=<code>`.

## Generic setup

Register a confidential (or public) client at your IdP:

| Setting | Value |
| --- | --- |
| Grant type | Authorization code (PKCE S256 is always used) |
| Redirect URI | `${BASE_URL}/api/auth/oidc/callback`, e.g. `https://status.example.com/api/auth/oidc/callback` |
| Scopes | `openid email profile` (+ whatever your IdP needs for groups) |
| Post logout redirect | not used |

Then configure the server:

```bash
BASE_URL=https://status.example.com
OIDC_ISSUER_URL=https://idp.example.com/realms/example
OIDC_CLIENT_ID=openstatuspage
OIDC_CLIENT_SECRET=<client secret>
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=statuspage-admins
OIDC_EDITOR_GROUP=statuspage-editors
```

`OIDC_ISSUER_URL` must be the issuer whose
`/.well-known/openid-configuration` document is reachable from the server.
`BASE_URL` must match the URL users open in the browser exactly, otherwise the
redirect URI does not match.

Plain `http://` issuers are accepted for local test setups only; use https in
production.

## Role mapping

The groups are read from the claim named in `OIDC_GROUPS_CLAIM` (default
`groups`). The claim may be an array or a space/comma separated string; dots
address nested claims (`realm_access.roles`). Group names are compared
case-insensitively and a leading `/` (Keycloak group paths) is ignored.

| Condition | Role |
| --- | --- |
| member of `OIDC_ADMIN_GROUP` | `admin` |
| member of `OIDC_EDITOR_GROUP` | `editor` |
| `OIDC_EDITOR_GROUP` not set | `editor` (every authenticated user) |
| `OIDC_EDITOR_GROUP` set, not a member of either group | login denied (`error=forbidden`) |

When `OIDC_ADMIN_GROUP` or `OIDC_EDITOR_GROUP` is set, the role is
**synchronised on every login**, so the IdP is the source of truth. Without any
group configured, existing users keep the role assigned in the management UI
and new users start as editor.

The sync follows the same rules as a role change in the management UI: when a
user loses the admin role, the admin API tokens they created are revoked. The
last admin is never demoted. Their login still works, they keep the admin role
and the server logs a warning; make another user admin (or fix the group
membership) to resolve it.

## Account linking

1. A user whose `oidc_subject` equals the token's `sub` is logged in.
2. Otherwise a local user with the same e-mail address is linked, **only if
   the IdP marks the e-mail as verified** (`email_verified: true`) and the user
   is not linked to another subject yet.
3. Otherwise a new user is created when `OIDC_AUTO_CREATE_USERS=true`
   (requires an `email` claim). The default is `false`.

> **Warning:** with `OIDC_AUTO_CREATE_USERS=true` and no group configured, every
> account the issuer can authenticate becomes an editor. Never combine this with
> multi-tenant or public issuers (e.g. Microsoft `common`/`organizations`, Google,
> GitLab.com) or IdPs with self-registration. Configure `OIDC_EDITOR_GROUP` /
> `OIDC_ADMIN_GROUP` instead.

Linked users can still use their local password unless you set
`LOCAL_LOGIN_ENABLED=false`.

## Offboarding

The IdP is only asked at login. Removing someone from the IdP or from the
configured groups therefore does not end a session they already have:

- At their next SSO login attempt they are rejected (`forbidden`) and all
  their sessions are ended.
- Otherwise the session ends at the latest `SESSION_MAX_AGE_HOURS` (default
  30 days) after its login, even when it is used every day.
- For immediate effect, also **delete the local user** in the management UI.
  That ends all sessions at once and revokes the API tokens they created. A
  linked user who still has a local password could otherwise keep using it.

## Error codes

| Code | Meaning |
| --- | --- |
| `oidc_unavailable` | Discovery failed (IdP unreachable or wrong issuer URL). |
| `invalid_state` | Login state cookie missing or expired. Start the login again. |
| `idp_error` | The IdP returned an error (e.g. user cancelled). |
| `oidc_failed` | Code exchange or ID token validation failed. See server log. |
| `forbidden` | User is not in an allowed group. |
| `no_account` | No matching user and auto creation is disabled. |
| `missing_email` | Auto creation needs an `email` claim. |
| `email_not_verified` | A local user with this e-mail exists, but the IdP did not mark the address as verified. |
| `account_conflict` | The local user with this e-mail is already linked to another IdP identity. |

## Provider notes

### Keycloak

- Create a client with *Client authentication* on and *Standard flow* enabled;
  add the redirect URI above.
- Issuer: `https://<keycloak-host>/realms/<realm>`.
- Groups: add a *Group Membership* mapper to the client's dedicated scope with
  token claim name `groups` (with or without *Full group path*; both work).
- To use realm roles instead set `OIDC_GROUPS_CLAIM=realm_access.roles`.

### Authentik

- Create an *OAuth2/OpenID Provider* (confidential client) and an application.
- Issuer: `https://<authentik-host>/application/o/<application-slug>/`.
- The default `profile` scope mapping already includes a `groups` claim with
  the user's group names.

### Microsoft Entra ID

- Register an application (web platform) with the redirect URI above and
  create a client secret.
- Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- Groups: in *Token configuration* add a groups claim. Entra sends group
  **object IDs**, so use the IDs as `OIDC_ADMIN_GROUP` / `OIDC_EDITOR_GROUP`,
  or use *App roles* and set `OIDC_GROUPS_CLAIM=roles` with the role values.
- Entra does not send `email_verified` by default, so existing local users are
  not linked automatically by e-mail: their SSO login fails with
  `email_not_verified`. Delete such local accounts (or change their e-mail)
  and let the first SSO login create the user instead.
