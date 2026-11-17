# Users and access

The public status page never requires a login. The management UI at `/admin`
and the admin API are for your team.

## Roles

| | Editor | Administrator |
| --- | --- | --- |
| Incidents and maintenance | create, update, delete | create, update, delete |
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
- Changing a user's password signs that user out everywhere.
- You cannot delete yourself, change your own role or remove the last
  administrator.

Every user can change their own password, language and theme in the user menu
(bottom left).

Sessions expire after `SESSION_TTL_HOURS` (default 168 hours = 7 days) without
activity; active sessions are extended automatically. The login is rate
limited to 10 attempts per minute per client IP.

Locked out? Use the `create-user` command to set a new password, see
[Installation](02-installation.md#the-first-administrator).

## Single sign-on (OIDC)

The management UI supports login through any OpenID Connect provider, e.g.
Keycloak, Authentik, Microsoft Entra ID, Okta or Zitadel. Short version:

1. Register a client at your identity provider with the redirect URI
   `${BASE_URL}/api/auth/oidc/callback`, e.g.
   `https://status.example.com/api/auth/oidc/callback`.
2. Configure the server:

   ```bash
   OIDC_ISSUER_URL=https://idp.example.com/realms/example
   OIDC_CLIENT_ID=openstatuspage
   OIDC_CLIENT_SECRET=<client secret>
   OIDC_ADMIN_GROUP=statuspage-admins
   OIDC_EDITOR_GROUP=statuspage-editors
   ```

3. Restart. The login page shows a button labelled with `OIDC_LABEL`
   (default "Single Sign-On").

Role mapping: members of `OIDC_ADMIN_GROUP` become administrators, members of
`OIDC_EDITOR_GROUP` editors. When one of these groups is configured, the role
is synchronised on every login. When `OIDC_EDITOR_GROUP` is set, users in
neither group are rejected; without it every account of the identity provider
that matches a user may log in as editor. The groups are read from the claim
`OIDC_GROUPS_CLAIM` (default `groups`).

By default only users that already exist in OpenStatusPage may log in (matched
by a verified email address on the first login). `OIDC_AUTO_CREATE_USERS=true`
creates users on their first login; enable it only together with the group
variables, otherwise every account of the identity provider becomes an
editor.

After SSO works and an SSO user is administrator, you can disable password
logins with `LOCAL_LOGIN_ENABLED=false`.

Provider-specific notes, all variables and the error codes shown on the login
page are documented in [`docs/oidc.md`](../../oidc.md).

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

Tokens are revoked automatically when the user who created them is deleted;
administrator tokens also when their creator loses the administrator role.
Revoke tokens that are no longer used; the list shows when each token was last
used. Changes made with a token appear in the audit log with the token name.

The API is described in [`docs/api.md`](../../api.md).

Ingest tokens of monitoring sources are separate: they only allow pushing
check results for their source and are managed on the source.

## Audit log

**Administration → Audit log** lists every change made in the management UI or
through the API, including logins, with user, time and affected object.
