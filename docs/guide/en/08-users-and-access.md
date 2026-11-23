# Users and access

The public status page never requires a login. The management UI at `/admin`
and the admin API are for your team.

## Roles

| | Editor | Administrator |
| --- | --- | --- |
| Incidents and maintenance | create, update, delete | create, update, delete |
| History corrections | create, update, delete | create, update, delete |
| Services, groups, locations, checks | read | manage |
| Monitoring sources | – | manage |
| Settings, email subscribers | – | manage |
| Users and API tokens | – | manage |
| Audit log | – | read |
| Help | read | read |

Give the editor role to everyone who only communicates incidents and
maintenance (e.g. the service desk), and keep the number of administrators
small.

## Local accounts

**Administration → Users** (administrators):

- Create users with name, email, role and a password (at least 10
  characters). For accounts that only use single sign-on, leave the password
  empty.
- Changing a user's password signs that user out everywhere and revokes the
  API tokens they created.
- You cannot delete yourself, change your own role or remove the last
  administrator.

Every user can change their own password, language and theme in the user menu
(bottom left).

Sessions expire after `SESSION_TTL_HOURS` (default 168 hours = 7 days) without
activity; active sessions are extended automatically, but never beyond
`SESSION_MAX_AGE_HOURS` (default 720 hours = 30 days) after the login. Then
everybody has to log in again. The login is rate limited to 10 attempts per
minute per client IP; in addition, repeated failed logins for one account make
its login wait (at most one minute), whatever the IP.

Locked out? Use the `create-user` command to set a new password, see
[Installation](02-installation.md#the-first-administrator). It also signs the
user out everywhere and revokes the API tokens they created, so it is the way
to reset a compromised account from the server.

## Single sign-on (OIDC)

The management UI supports login through any number of OpenID Connect
providers, e.g. Keycloak, Authentik, Microsoft Entra ID, Okta or Zitadel. Each
enabled provider gets its own button on the login page; the password login
stays available unless you disable it.

### Adding a provider in the management UI

1. Open **Administration → Single sign-on** and choose **Add provider**. Enter
   a name (shown on the button), the issuer URL, the client ID and the client
   secret of the client you registered at the identity provider. Untick
   **Enabled** for now.
2. **Test configuration** checks that the server reaches the identity provider
   and shows its endpoints.
3. Save. The dialog now shows the **redirect URI** of this provider, e.g.
   `https://status.example.com/api/auth/oidc/<provider id>/callback`. Register
   it at the identity provider, then tick **Enabled**.

The client secret is stored encrypted and never shown again; leave the field
empty when editing to keep it.

**Users and roles** of a provider:

- **Create users on their first sign-in**: off by default, so only users that
  already exist in OpenStatusPage can sign in (matched by a verified e-mail
  address on the first login). When on, users are only created for e-mail
  addresses the identity provider marks as verified.
- **Allowed e-mail domains**: optional; only verified addresses of these
  domains can sign in through this provider.
- **Role claim** and **role mapping**: the claim with the groups or roles
  (e.g. `groups`, `roles` or `realm_access.roles`) and which values grant
  *Admin*, *Editor* or *No access*. *No access* always wins.
- **Role without a matching value**: *Editor* or *No access*.
- **Update the role**: *on every sign-in* (the identity provider decides) or
  *only when the user is created* (afterwards you manage the role here).

Never let a public or multi-tenant identity provider create users without a
role mapping, allowed domains or *No access* as the default role: every account
it can authenticate would become an editor. The form warns you in this case.

### The provider from the environment

The provider configured with environment variables, as before, keeps working
and is listed with the badge **From environment** (read-only). Its redirect
URI stays `${BASE_URL}/api/auth/oidc/callback`:

```bash
OIDC_ISSUER_URL=https://idp.example.com/realms/example
OIDC_CLIENT_ID=openstatuspage
OIDC_CLIENT_SECRET=<client secret>
OIDC_ADMIN_GROUP=statuspage-admins
OIDC_EDITOR_GROUP=statuspage-editors
```

Members of `OIDC_ADMIN_GROUP` become administrators, members of
`OIDC_EDITOR_GROUP` editors. When `OIDC_EDITOR_GROUP` is set, users in neither
group are rejected; without it every account of the identity provider that
matches a user may log in as editor. `OIDC_AUTO_CREATE_USERS=true` creates
users on their first login (verified e-mail only).

### Roles and linking

When the role is updated on every sign-in, losing the administrator role
revokes the user's administrator API tokens, just like a change in the
management UI. The last administrator is never demoted this way; the server
logs a warning instead.

A user can be linked to several providers (one identity per provider). After
SSO works and an SSO user is administrator, you can disable password logins
with `LOCAL_LOGIN_ENABLED=false`.

Offboarding: the identity provider is only asked at login. Someone you remove
or disable there keeps an existing session until `SESSION_MAX_AGE_HOURS` at
the latest, and API tokens they created stay valid. A linked user who still
has a local password can also keep signing in with it unless
`LOCAL_LOGIN_ENABLED=false`, and one linked to several providers can use the
others. So when someone leaves, always delete the user in
**Administration → Users** as well: that ends all sessions and revokes their
tokens at once.

Provider-specific notes, all settings and variables and the error codes shown
on the login page are documented in [`docs/oidc.md`](../../oidc.md).

## API tokens

Scripts and integrations use the admin API with an API token instead of a
login. **Administration → API tokens** (administrators):

1. Create a token with a descriptive name and a role (editor or
   administrator). The token has exactly the permissions of a user with that
   role.
2. Copy the token (it starts with `osp_`). It is shown only once and stored as
   a hash.
3. Send it as a bearer token:

   ```bash
   curl -fsS https://status.example.com/api/admin/incidents \
     -H "Authorization: Bearer $OSP_API_TOKEN"
   ```

The API speaks [JSON:API 1.1](https://jsonapi.org/format/1.1/) (since 0.2.0):
answers are documents with `data`, `included`, `meta` and `links`, errors are
listed in `errors`. Requests with a body send
`Content-Type: application/vnd.api+json` and wrap the fields in `data`. For
example, to post an incident:

```bash
curl -fsS https://status.example.com/api/admin/incidents \
  -H "Authorization: Bearer $OSP_API_TOKEN" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{"data":{"type":"incidents","attributes":{"title":"Slow logins","message":"We are investigating."}}}'
```

Updates use `PATCH` and only change the fields you send.

Tokens are revoked automatically when the user who created them is deleted;
administrator tokens also when their creator loses the administrator role.
A token created with another token belongs to the owner of that token.
Revoke tokens that are no longer used; the list shows when each token was last
used. Changes made with a token appear in the audit log with the token name.

The API is described in [`docs/api.md`](../../api.md).

Ingest tokens of monitoring sources are separate: they only allow pushing
check results for their source and are managed on the source.

## Audit log

**Administration → Audit log** lists every change made in the management UI or
through the API, including logins, with user, time and affected object.
