# Single sign-on with OpenID Connect

The management UI supports login through any number of OpenID Connect
providers (Keycloak, Authentik, Microsoft Entra ID, Okta, Zitadel, Dex, ...).
The public status page never requires a login.

There are two ways to configure a provider:

- **In the management UI** (*Administration → Single sign-on*, admins only):
  any number of providers, each with its own button on the login page.
- **With environment variables** (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, ...):
  one provider, as in 0.3.x. It keeps working unchanged after the upgrade.

Local password login stays available next to SSO unless
`LOCAL_LOGIN_ENABLED=false`.

## How it works

1. The login page shows one button per enabled provider ("Sign in with
   *name*"): the provider of the environment first, then the providers of the
   management UI in their button order.
2. `GET /api/auth/oidc/<provider id>/login` (environment provider:
   `/api/auth/oidc/login`) redirects to the IdP using the **authorization code
   flow with PKCE** (S256, always on). The PKCE verifier, `state`, `nonce` and
   the provider id are kept in a signed, http-only cookie that expires after
   10 minutes.
3. The IdP redirects back to `GET /api/auth/oidc/<provider id>/callback`
   (environment provider: `/api/auth/oidc/callback`). Every provider has its
   own redirect URI, and the callback only accepts a login state cookie that
   names this provider, so an authorization response can never be redeemed at
   another provider (`invalid_state`). The server exchanges the code, validates
   the ID token (signature, issuer, audience, nonce) and reads the claims.
   Missing claims (e.g. groups) are taken from the userinfo endpoint when the
   IdP offers one.
4. The user is mapped to a local account and gets a new session cookie (the
   session the browser held before is deleted). On errors the browser is sent
   to `/admin/login?error=<code>`.

## Providers in the management UI

Open *Administration → Single sign-on* and choose *Add provider*.

| Setting | Meaning |
| --- | --- |
| Name | Shown on the login button. |
| Button order | Buttons are sorted by this number (ascending), then by name. |
| Enabled | Only enabled providers get a button; the routes of a disabled provider answer `oidc_unavailable`. |
| Issuer URL | The issuer whose `/.well-known/openid-configuration` the server can reach. Must be `https://` in production (`NODE_ENV=production`); plain `http://` is refused when `NODE_ENV=production` (the environment provider keeps accepting it, as in 0.3.x). No credentials, query or fragment. |
| Client ID / Client secret | From the client registration. The secret is **write-only**: it is stored encrypted with `SECRET_KEY` (AES-256-GCM) and never shown again; leave the field empty to keep it, or tick *Remove the stored secret (public client)*. |
| Scopes | Space separated, must contain `openid`. Add the scope your IdP needs for groups or roles. |
| Create users on their first sign-in | Off by default. Only for e-mail addresses the IdP marks as verified (`email_verified: true`). |
| Allowed e-mail domains | Optional, one per line. When set, only **verified** addresses of exactly these domains (no subdomains) may sign in through this provider, also users that are already linked (`domain_not_allowed`). |
| Role claim | Claim with the groups or roles, see [Role mapping](#role-mapping). |
| Role mapping | Claim values and what they grant: *Admin*, *Editor* or *No access*. |
| Role without a matching value | *Editor* or *No access*. Admin is only granted by an explicit mapping. |
| Update the role | *On every sign-in* (the IdP is the source of truth) or *Only when the user is created*. |

After saving, the dialog shows the provider's **redirect URI**,
`${BASE_URL}/api/auth/oidc/<provider id>/callback`, e.g.
`https://status.example.com/api/auth/oidc/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b/callback`.
Register it at the IdP. A common order is: add the provider disabled, copy the
redirect URI to the IdP, then enable it.

**Test configuration** fetches the discovery document of the issuer URL (also
before saving) and shows the issuer and the authorization, token, userinfo,
JWKS and end session endpoints, or why it failed (unreachable, HTTP error,
redirect, not a discovery document, an issuer that differs from the configured
URL, endpoints that are not https, no authorization code flow). It follows the
rules of every request an admin can trigger: admins only, at most 10 tests per
minute, a 10 second time limit, at most 256 KiB, no redirects followed, and
messages without credentials or query strings. Only a plain `GET` is sent; the
client id and secret never leave the server. Like monitoring sources, the test
also reaches hosts inside your network.

Every change is written to the audit log (`oidc_provider.create`, `.update`,
`.delete`) with the changed fields; the secret only as `set` or `removed`.
Deleting a provider removes its links to user accounts (not the accounts).

Up to 50 providers can be stored.

## The provider of the environment

The `OIDC_*` variables keep configuring one provider exactly like in 0.3.x
(same routes, same redirect URI `${BASE_URL}/api/auth/oidc/callback`, same role
rules). It is **not** copied into the database: the management UI lists it as
*From environment*, read-only, with its redirect URI and the test button. Change
it in the environment and restart. Users linked with 0.3.x stay linked to it
(migration `0016_oidc_providers` moves the links).

```bash
BASE_URL=https://status.example.com
OIDC_ISSUER_URL=https://idp.example.com/realms/example
OIDC_CLIENT_ID=openstatuspage
OIDC_CLIENT_SECRET=<client secret>
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=statuspage-admins
OIDC_EDITOR_GROUP=statuspage-editors
```

It translates to the provider settings like this:

| Environment | Provider setting |
| --- | --- |
| `OIDC_LABEL` | Name |
| `OIDC_SCOPES` | Scopes |
| `OIDC_GROUPS_CLAIM` | Role claim |
| `OIDC_ADMIN_GROUP` | Mapping *value → Admin* |
| `OIDC_EDITOR_GROUP` | Mapping *value → Editor*; with it the default is *No access*, without it *Editor* |
| `OIDC_AUTO_CREATE_USERS` | Create users on their first sign-in |
| – | Update the role: on every sign-in; no allowed domains |

To move it into the management UI, add a provider there with the same issuer
and client, register its new redirect URI at the IdP, and remove the `OIDC_*`
variables. Users linked to the environment provider link again on their next
login through a verified e-mail address.

## Generic IdP setup

Register a confidential (or public) client at your IdP:

| Setting | Value |
| --- | --- |
| Grant type | Authorization code (PKCE S256 is always used) |
| Redirect URI | The provider's redirect URI (see above) |
| Scopes | `openid email profile` (+ whatever your IdP needs for groups) |
| Post logout redirect | not used |

`BASE_URL` must match the URL users open in the browser exactly, otherwise the
redirect URI does not match.

## Role mapping

The values are read from the role claim (default `groups`). The claim may be an
array or a space/comma separated string; dots address nested claims
(`realm_access.roles`), a claim whose name contains dots (e.g.
`https://example.com/groups`) is found as well. Values are compared
case-insensitively and a leading `/` (Keycloak group paths) is ignored.

| Condition | Role |
| --- | --- |
| a value mapped to *No access* | login denied (`forbidden`), whatever else matches |
| a value mapped to *Admin* | `admin` |
| a value mapped to *Editor* | `editor` |
| no value mapped | the default role: `editor`, or login denied (`forbidden`) |

With **at least one mapping** and *Update the role: on every sign-in*, the role
is **synchronised on every login**, so the IdP is the source of truth. With
*only when the user is created*, or without any mapping, existing users keep
the role assigned in the management UI and the mapping only sets the role of
new users. A denied login (*No access*, or the default role *No access*) is
enforced on every login in every mode.

The sync follows the same rules as a role change in the management UI: when a
user loses the admin role, the admin API tokens they created are revoked. The
last admin is never demoted. Their login still works, they keep the admin role
and the server logs a warning; make another user admin (or fix the group
membership) to resolve it.

## Account linking

Identities are linked **by `sub` per provider**: a user can be linked to
several providers, but to one identity per provider.

1. A user linked to the token's `sub` at this provider is logged in.
2. Otherwise a local user with the same e-mail address is linked, **only if
   the IdP marks the e-mail as verified** (`email_verified: true`) and the user
   is not linked to another identity of this provider yet (`account_conflict`).
3. Otherwise a new user is created when the provider creates users. This also
   requires an `email` claim **that the IdP marks as verified**: the address
   becomes the account's unique identity, so an unverified one could claim the
   address of a person who has no account yet.

> **Note:** some IdPs never send `email_verified` (e.g. Microsoft Entra ID by
> default, see below). With such an IdP neither linking by e-mail, auto
> creation nor allowed domains work (`email_not_verified`) until you configure
> it to send the claim. Users already linked by `sub` are not affected (unless
> the provider has allowed domains).

> **Warning:** with auto creation, the default role *Editor*, no mapping to
> *No access* and no allowed domains, every account the issuer can
> authenticate becomes an editor. Never combine this with multi-tenant or
> public issuers (e.g. Microsoft `common`/`organizations`, Google, GitLab.com)
> or IdPs with self-registration. The form shows a warning in this case.

Linked users can still use their local password unless you set
`LOCAL_LOGIN_ENABLED=false`.

The `create-user` command refuses to set a password or role on an account that
is linked to an IdP identity, since whoever holds that identity would get them
too. After checking that the account belongs to the owner of the address, run
it again with `--unlink-oidc`: it sets password and role and removes the links
to every provider (the next SSO login links again only through a verified
e-mail).

## Offboarding

The IdP is only asked at login. Removing or disabling someone in the IdP, or
removing them from the mapped groups, does not end a session they already
have, and API tokens they created stay valid:

- An existing session ends at the latest `SESSION_MAX_AGE_HOURS` (default 30
  days) after its login, even when it is used every day.
- Only when an SSO login is rejected because of the role mapping (`forbidden`)
  or because of the allowed domains (`domain_not_allowed`) are all sessions of
  the linked user ended and their API tokens revoked right away. An account
  disabled in the IdP never reaches this point.
- A linked user who still has a local password can keep signing in with it
  unless `LOCAL_LOGIN_ENABLED=false`, and a user linked to several providers
  can keep signing in through the others.
- For immediate effect, **delete the local user** in the management UI. That
  ends all sessions at once and revokes the API tokens they created.

## Error codes

| Code | Meaning |
| --- | --- |
| `oidc_unavailable` | The provider is unknown or disabled, its secret cannot be decrypted (changed `SECRET_KEY`), or discovery failed (IdP unreachable or wrong issuer URL). |
| `invalid_state` | Login state cookie missing, expired or started at another provider. Start the login again. |
| `idp_error` | The IdP returned an error (e.g. user cancelled). |
| `oidc_failed` | Code exchange or ID token validation failed. See server log. |
| `forbidden` | The role mapping denies the user. |
| `domain_not_allowed` | The verified e-mail address is not in one of the provider's allowed domains. |
| `no_account` | No matching user and auto creation is disabled. |
| `missing_email` | Auto creation or allowed domains need an `email` claim. |
| `email_not_verified` | The IdP did not mark the e-mail as verified, so it is neither linked to the local user with this address, used to create a new user, nor accepted for an allowed domain. |
| `account_conflict` | The local user with this e-mail is already linked to another identity of this provider. |
| `missing_subject` | The ID token has no `sub`. |

## Provider notes

### Keycloak

- Create a client with *Client authentication* on and *Standard flow* enabled;
  add the redirect URI above.
- Issuer: `https://<keycloak-host>/realms/<realm>`.
- Groups: add a *Group Membership* mapper to the client's dedicated scope with
  token claim name `groups` (with or without *Full group path*; both work).
- To use realm roles instead set the role claim to `realm_access.roles`
  (`OIDC_GROUPS_CLAIM=realm_access.roles`), client roles are at
  `resource_access.<client id>.roles`.

### Authentik

- Create an *OAuth2/OpenID Provider* (confidential client) and an application.
- Issuer: `https://<authentik-host>/application/o/<application-slug>/` (with
  the trailing slash: the test reports a differing issuer otherwise).
- The default `profile` scope mapping already includes a `groups` claim with
  the user's group names.

### Microsoft Entra ID

- Register an application (web platform) with the redirect URI above and
  create a client secret.
- Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- Groups: in *Token configuration* add a groups claim. Entra sends group
  **object IDs** in `groups`, so map the IDs; or define *App roles*, set the
  role claim to `roles` and map the role values.
- Entra does not send `email_verified` by default, so local users are not
  linked by e-mail, auto creation creates nobody and allowed domains let
  nobody in: the first SSO login fails with `email_not_verified`. Configure the
  application to emit an `email_verified` claim (e.g. with a claims mapping
  policy) only for addresses your tenant actually owns.
