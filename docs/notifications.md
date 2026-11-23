# Email notifications

Visitors of the status page can subscribe to email notifications about incidents
and maintenance. This page explains how subscriptions work, how to connect a mail
server and how to operate and troubleshoot delivery.

## Overview

- Subscribers choose **All updates** or **Selected services** (public services
  only; the form groups them by their group). The choice is stored per service.
- **Double opt-in**: a new subscription stays inactive until the subscriber clicks
  the link in the confirmation email. Unconfirmed subscriptions are deleted after
  7 days.
- Only **public** incidents and maintenance ever cause emails, and emails only name
  **public** services. Hidden services, locations and monitoring details never
  appear in an email.
- Every incident and maintenance form in the management UI has a
  **Notify subscribers** checkbox (on by default):
  - incidents: creating an incident and posting an update (including **Resolve**);
  - maintenance: the announcement when it is created, and every posted update
    (including **Start now**, **Complete** and **Cancel maintenance**).
  The maintenance stores this flag: the automatic start and completion (when
  `autoStart`/`autoComplete` are set) and the reminder are only sent when the flag
  is set. The flag can be changed later when editing the maintenance.
- **Reminder**: subscribers get a reminder before a scheduled maintenance starts
  (setting **Maintenance reminder (hours)**, 0–168, default 24, `0` disables
  reminders).
  Each window is reminded once. A maintenance created less than the reminder period
  before its start is not reminded (the announcement was just sent). When the
  start is moved later, a new reminder is sent before the new start. While
  neither a mail transport nor a webhook or SMS recipient exists, due reminders
  wait and are sent once one is set up (still before the start).
- Emails are sent in the subscriber's language (English or German), as plain text
  plus a simple HTML version. Times are shown in UTC. Both parts carry the same
  content; the HTML part is built for WCAG 2.2 AA (language, headings, relative
  font sizes, contrast-safe button colors derived from the accent color), see
  [accessibility.md](accessibility.md#emails).
- Every notification contains links to manage the subscription and to unsubscribe,
  and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers for one-click
  unsubscribe in mail clients (RFC 8058). The unsubscribe link in the body opens
  the manage page with `&unsubscribe=1`, which shows the unsubscribe confirmation
  right away. The one-click header URL unsubscribes on `POST` (what mail clients
  send); opening it in a browser (`GET`) only redirects (`303`) to the manage page
  with the unsubscribe confirmation and never deletes anything.
- Links in the email body carry their token in the query string, so the server
  renders the confirm and manage pages and they work without JavaScript (see
  [security-model.md](security-model.md#html-forms)):
  - confirm: `${BASE_URL}/subscription/confirm?id=<id>&token=<confirmToken>`
  - manage: `${BASE_URL}/subscription/manage?id=<id>&token=<manageToken>`
  - unsubscribe: `${BASE_URL}/subscription/manage?id=<id>&token=<manageToken>&unsubscribe=1`

  The confirm page asks for one click (a form), so link scanners of mail
  providers confirm nothing. Links of older emails with the token in the URL
  fragment (`#token=`) keep working in browsers with JavaScript. The
  `List-Unsubscribe` header uses the API URL with `?token=` (mail clients post to
  it directly). The server log redacts every token as `token=[REDACTED]`.

### Who receives what

| Event | Recipients |
| --- | --- |
| Incident or maintenance affecting public services | Confirmed subscribers with *All updates*, plus subscribers of at least one affected public service |
| Incident or maintenance without (public) affected services | Confirmed subscribers with *All updates* only |
| Hidden (non-public) incident / maintenance, *Notify subscribers* unchecked, or subscriptions disabled in the settings | Nobody |

## Enabling subscriptions

1. Configure a mail transport (see below) and restart the server.
2. In the management UI open **Administration → Settings**, section
   **Email subscriptions**, and enable **Offer email subscriptions**. Optionally
   adjust **Maintenance reminder (hours)**.
3. Check the **Email delivery** panel in the same section and send a test email
   (see [Troubleshooting](#troubleshooting)).

The public page offers subscriptions (entry **Email notifications** in the
**Subscribe to updates** menu, form at `/subscribe`) only when they are enabled
**and** a transport (`smtp` or `log`) is configured. Disabling subscriptions stops
all new notifications, including reminders and automatic start/completion emails
(emails already in the outbox are still delivered); existing subscribers are kept
and can still manage or cancel their subscription.

## Mail transport

The transport is selected with environment variables (full list in
[configuration.md](configuration.md#email-notifications)):

| `MAIL_TRANSPORT` | Behaviour |
| --- | --- |
| `smtp` | Sends via an SMTP server (`SMTP_HOST`, ...). Default when `SMTP_HOST` is set. |
| `log` | Writes every email to the server log instead of sending it. For development and testing only: the log then contains confirmation and manage links. |
| `none` | No email at all; subscriptions are not offered. Default without `SMTP_HOST`. |

`SMTP_FROM` is required for `smtp` and `log`, e.g. `Example Status <status@example.com>`.
Use an address of a domain you control (see [Deliverability](#deliverability)).

### SMTP with STARTTLS (port 587, recommended)

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=status@example.com
SMTP_PASSWORD=change-me
SMTP_FROM=Example Status <status@example.com>
```

With `SMTP_SECURE=false` (default) the connection is upgraded with STARTTLS when the
server offers it. The server certificate is verified
(`SMTP_TLS_REJECT_UNAUTHORIZED=true`).

### SMTP with implicit TLS (port 465)

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=status@example.com
SMTP_PASSWORD=change-me
SMTP_FROM=Example Status <status@example.com>
```

### Internal relay without authentication

Leave `SMTP_USER`/`SMTP_PASSWORD` empty. For a relay with a self-signed certificate
you can set `SMTP_TLS_REJECT_UNAUTHORIZED=false`; only do this inside a trusted
network, since it allows interception of the connection.

### Docker Compose

The [Compose setup](guide/en/02-installation.md) hands every setting of the
`.env` next to `compose.yaml` to the app, so `MAIL_TRANSPORT` and the `SMTP_*`
variables only have to be set there; the compose file itself does not need to
be edited. The template ([`deploy/compose/.env.example`](../deploy/compose/.env.example))
already contains them as comments:

```bash
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.example.com
SMTP_USER=status@example.com
SMTP_PASSWORD='change-me'
SMTP_FROM='Example Status <status@example.com>'
```

Wrap values containing `$` in single quotes, Compose would interpolate them
otherwise. Apply changes with `docker compose up -d` in the directory of
`compose.yaml` (it recreates the container when the settings changed).

## Delivery

Emails are not sent inside the web request. Every email is first written to an
outbox table (`email_outbox`) and delivered by a background task:

- runs every 10 seconds and right after new emails were queued; each run sends due
  emails in batches of 50 (up to 10 batches per run);
- failed attempts are retried after 1 min, 5 min, 15 min and 1 h; after 5 failed
  attempts the email is marked **failed**;
- failed emails can be queued again by an admin (**Retry failed** in the
  **Email delivery** panel,
  `POST /api/admin/notifications/retry-failed`), e.g. after fixing the SMTP
  credentials;
- sent and failed emails are deleted after 30 days;
- emails of a subscriber who unsubscribes are deleted with the subscriber (an email
  whose subscriber no longer exists at sending time is dropped).

Tokens are never written to the outbox. Subscriber emails are queued with
placeholders instead of the confirm and manage tokens; the delivery task derives
the real tokens from `SECRET_KEY`, the subscriber id and its salt right before
sending and fills them into the body (text and HTML) and the `List-Unsubscribe`
header. Placeholders only ever stand in the links the templates build: one that
an editor writes into a title or message (or a service or site name) is removed
when the email is rendered, so it can never turn into a token. After an email was sent, its bodies and headers are blanked in the outbox;
recipient, subject, kind and status stay for the status view. Failed emails keep
their placeholder bodies so that **Retry failed** can send them again.

Background tasks run only where `WORKER_ENABLED=true`. With several replicas, enable
the worker on exactly one instance (as for monitoring polls). If no instance runs
the worker, emails stay queued.

A large incident with many subscribers queues one email per subscriber. A run sends
up to 500 emails (10 batches of 50) as fast as the SMTP server accepts them, over at
most 2 parallel connections; check the sending limits of your mail provider.

## Data stored and deletion

For each subscriber the database stores:

- email address (lowercase), language, *All updates* flag and the selected services;
- creation and confirmation timestamps and the time of the last confirmation email;
- a random salt. The confirm and manage tokens in the links are derived from the
  salt and `SECRET_KEY` (HMAC-SHA256) and are **never stored**, neither in the
  subscriber row nor in the outbox. Changing `SECRET_KEY` therefore invalidates all
  links in emails already sent.

The outbox keeps recipient, subject, kind and status of every email for at most 30
days. The body is only kept (with token placeholders) until the email is sent; failed
emails keep it until they are retried or deleted.

Deletion:

- Unconfirmed subscriptions are deleted automatically 7 days after the last
  confirmation email.
- Subscribers can unsubscribe with the link in every email or on the manage page;
  this deletes the subscriber, the selected services and queued emails completely.
- Admins can list, search, filter and delete subscribers under
  **Administration → Subscribers** (`GET`/`DELETE /api/admin/subscribers`). The audit log records the deletion with a
  masked address (`j***@example.com`).

Subscribing answers identically for new, pending and already confirmed addresses,
so the form cannot be used to find out whether an address is subscribed. The work
that depends on the address runs after the answer has been sent, so the response
time does not give it away either. Subscribing again never changes the preferences
of an existing address (they only change through the manage link): pending
subscribers get the confirmation email again, confirmed subscribers an email with
their manage link instead; at most
one confirmation or manage email is sent per address every 10 minutes, and the
subscribe endpoint and the subscribe form are limited to 5 requests per minute per
client IP together. Behind a
reverse proxy set `TRUST_PROXY` so the limit applies per visitor.

The form also contains a hidden honeypot field (`website`) that people never fill
in. When a bot fills it in, the request is answered exactly like a successful
subscription (`202`), but nothing is stored and no email is sent, so the bot gets
no hint that it was detected.

Mention the subscription in your privacy policy (purpose, data stored, retention,
the mail provider you use as processor).

## Deliverability

Notification emails are only useful if they do not end up in spam folders:

- **Sender domain**: use `SMTP_FROM` with a domain you control and send through a
  server that is allowed to send for it.
- **SPF**: publish an SPF record that includes your mail server, e.g.
  `example.com. TXT "v=spf1 include:_spf.mail-provider.example -all"`.
- **DKIM**: let your mail server or provider sign outgoing mail and publish the
  DKIM public key in DNS.
- **DMARC**: publish a DMARC policy, e.g.
  `_dmarc.example.com. TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"`.
  The `From` domain must align with SPF or DKIM.
- **Reverse DNS / HELO**: when running your own mail server, the sending IP needs a
  matching PTR record.
- Keep `BASE_URL` set to the real public URL: it is used for every link in emails.
  Links pointing to `localhost` are a strong spam signal (and do not work).

Emails carry `List-Unsubscribe` with one-click support and
`Auto-Submitted: auto-generated`, which large mailbox providers expect from bulk
senders.

## Troubleshooting

**Status.** The **Email delivery** panel on the settings page (admins,
`GET /api/admin/notifications/status`) shows the transport (*SMTP*, *Server log* or
*Not configured*), the sender, subscriber counts (confirmed/pending), the queue
(pending/failed), the time of the last sent email and the last delivery error. It
warns when subscriptions are enabled but no transport is configured. Email addresses
in SMTP error messages are masked (`j***@example.com`) before the error is stored or
logged.

**Test email.** **Send test email** in the **Email delivery** panel (or `POST /api/admin/notifications/test` with
`{ "to": "you@example.com" }`) sends immediately, bypassing the queue, and returns
the SMTP error message when sending fails.

**Log transport.** For local development set `MAIL_TRANSPORT=log` and
`SMTP_FROM=status@example.com`: emails including confirmation links are written to
the server log.

**Server log.** Failed deliveries are logged at level `warn`
(`email delivery failed`, with outbox id, kind, attempt and error, without the
recipient address; addresses inside the SMTP error are masked). Queued notifications are logged at `info`
(`subscriber notifications queued`).

Common problems:

| Symptom | Cause / fix |
| --- | --- |
| No subscribe form on the public page | Subscriptions disabled in the settings, or `MAIL_TRANSPORT` is `none` (no `SMTP_HOST`). |
| Server does not start: `SMTP_FROM: required ...` | `SMTP_FROM` is mandatory for `smtp` and `log`. |
| Queue grows, nothing is sent | No instance with `WORKER_ENABLED=true`, or every attempt fails: check **Last error**. |
| `Invalid login` / `535 Authentication failed` | Wrong `SMTP_USER`/`SMTP_PASSWORD`; some providers need an app password. |
| `self-signed certificate` / `unable to verify the first certificate` | Install a valid certificate on the relay (or, inside a trusted network only, `SMTP_TLS_REJECT_UNAUTHORIZED=false`). |
| `wrong version number` / connection hangs | `SMTP_SECURE` does not match the port: `true` for 465, `false` for 587/25. |
| `Connection timeout` | Firewall or hosting provider blocks outgoing SMTP ports; many cloud providers block port 25. |
| Emails arrive in spam | Check SPF, DKIM and DMARC for the `SMTP_FROM` domain. |
| Links in emails are wrong | `BASE_URL` is not the public URL of the status page. |
| Confirmation link says it is invalid | The subscription expired (7 days) or `SECRET_KEY` was changed; subscribe again. |

# Webhooks and SMS

Besides email, notifications go to webhooks (Discord, Slack, Microsoft Teams,
generic JSON) and by SMS: to admin-configured destinations and, when the admin
allows it, to visitors. The guide chapter
[Webhooks and SMS](guide/en/13-webhooks-and-sms.md) explains the set-up; this
section is the reference.

## Events

Webhooks and SMS get exactly the events of the subscriber mails (only public
incidents and maintenance, only public service names):

| Event | When |
| --- | --- |
| `incident.created` | A public incident is created with **Notify subscribers**. |
| `incident.updated` | An update is posted with **Notify subscribers**. |
| `incident.resolved` | The update sets the status to `resolved`. |
| `maintenance.scheduled` | A public maintenance is created with notifications on. |
| `maintenance.updated` | An update is posted while the window is still scheduled. |
| `maintenance.started` / `maintenance.completed` / `maintenance.cancelled` | The status changes (by hand or automatically). |
| `maintenance.reminder` | The reminder before the window (settings.maintenanceReminderHours). |
| `subscription.confirm` | A visitor subscribed: the message with the 6-digit code. |
| `subscription.manage` | A visitor subscribed an already confirmed destination again. |
| `test` | The test button of the admin UI. |

Scope: a recipient with **all services** gets every event; one with selected
services gets the events that affect one of them (events without services only
reach "all services" recipients).

## Delivery

Every message goes through the `channel_outbox` table and the worker task
`channel-delivery` (every 10 s, also triggered right after an event):

- Rows hold the public event data only. The destination (URL, number) and the
  subscriber's tokens are looked up and the message is rendered right before
  sending.
- Retries after 1, 5, 15 and 60 minutes, at most 5 attempts. `4xx` answers other
  than 408, 425 and 429 are final.
- Rate limits (**Administration → Webhooks & SMS**, section *Visitor subscriptions and limits*): webhook requests per destination
  and minute, subscriber webhook messages per minute, subscriber SMS per minute
  and confirmation SMS per hour. A message over a limit waits a minute without
  losing an attempt. The limits are counted in memory by the instance that holds
  the task's lease (one at a time).
  - The destination is the webhook itself for admin webhooks and for visitors'
    Discord, Slack and Teams webhooks (these services limit per webhook), and the
    host for visitors' generic webhooks. Admin webhooks never wait behind
    visitors' messages to the same service.
  - On-call SMS are never postponed; they count toward the SMS per minute, so
    subscriber SMS slow down while they go out.
  - Throughput: visitor webhooks go out at **subscriber webhook messages per
    minute** (default 60) in total, at most **webhook requests per destination**
    (default 30) to one webhook or generic host. With the defaults, an event for
    600 webhook subscribers takes about 10 minutes, one for 300 SMS subscribers
    about 10 minutes at 30 SMS per minute. Raise the limits if your provider
    allows more.
- An admin webhook is disabled after 10 failed requests in a row; the admins get
  an email (when a mail transport is configured), and the audit log records
  `webhook.auto_disable`.
- A subscriber is removed when the destination refused its last 5 messages:
  a webhook answered `4xx` (other than 408, 425 and 429, for example `404` or
  `410` for a deleted webhook), or the SMS provider rejected the number (`400`,
  `410` or `422`) while it accepted other SMS in the same time. Failures with a
  cause on the server's side never count: the SMS budget, the channel settings,
  a changed key, a refused or unreachable address, network errors, `5xx`
  answers and provider answers such as `401`, `403` or `404` (wrong
  credentials or URL). A sent message in between starts the count again.
- Sent rows lose their payload; all rows are deleted after 40 days (the monthly
  SMS budget counts the rows of the current month).

## Outbound requests (SSRF protection)

Every webhook and SMS provider request goes through one guard
(`apps/server/src/lib/safe-http.ts`):

- `https://` only; admin webhooks may allow `http://` explicitly. No user info in
  URLs.
- The host is resolved once. If any address is private (RFC 1918), loopback,
  link-local (including 169.254.169.254), CGNAT (100.64/10), multicast,
  reserved, documentation, IPv6 unique local, NAT64, 6to4, Teredo or
  IPv4-mapped, the request is refused. IP literals are refused the same way;
  decimal, octal and hex IPv4 spellings are normalized by the URL parser first.
- The connection goes to the checked address (no second DNS lookup, so DNS
  rebinding cannot switch it); TLS still verifies the certificate for the host
  name.
- No redirects, a 10 s deadline for the whole request, at most 16 KiB of the
  answer read, no connection reuse, no proxy.
- Subscriber webhooks of type Discord, Slack and Teams must use the official
  hosts and paths (`discord.com/api/webhooks/…`, `hooks.slack.com/services/…`,
  `*.logic.azure.com/workflows/…/paths/invoke`,
  `*.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/…`),
  without a port. Generic subscriber webhooks need the admin setting
  **Visitors may also use generic webhooks** (off by default). The worker checks the destination
  against these rules again before every delivery.
- Errors stored in the delivery log and written to the server log never contain
  the URL's path or query, credentials or phone numbers (numbers in provider
  answers are masked).

## Formats

- **Discord**: one embed (title, link, description, color by impact, fields,
  footer, timestamp); `allowed_mentions: { parse: [] }`, markdown in editor text
  is escaped.
- **Slack**: Block Kit (header, section with the message, fields, a button to
  the event, context with the manage link) and `text` as fallback; `&`, `<`, `>`
  are escaped.
- **Microsoft Teams**: `{ "type": "message", "attachments": [ { "contentType":
  "application/vnd.microsoft.card.adaptive", "content": <Adaptive Card 1.4> } ] }`,
  the format the Teams **Workflows** trigger "When a Teams webhook request is
  received" accepts. It answers `202 Accepted`. Office 365 connector URLs
  (`*.webhook.office.com`) are retired by Microsoft and not accepted for visitors.
- **SMS**: one segment. Texts use GSM-7 where possible (typographic quotes,
  dashes and ellipses are replaced) and are shortened to 160 characters, or to 70
  when other characters remain. Subscriber SMS end with the short manage link
  `<PUBLIC_BASE_URL>/s/<id>/<token>`.

### Generic JSON payload

`Content-Type: application/json`, `POST`, version 1. Fields are only added in
later versions, never renamed or removed; a breaking change gets a new
`version`.

```json
{
  "version": 1,
  "id": "6f1c…",
  "event": "incident.created",
  "occurredAt": "2026-11-20T10:00:00.000Z",
  "locale": "en",
  "site": { "name": "Example Status", "url": "https://status.example.com" },
  "headline": "Incident: API errors",
  "text": "We are looking into it.",
  "incident": {
    "id": "inc-1",
    "title": "API errors",
    "status": "investigating",
    "impact": "major",
    "services": ["Public API"],
    "message": "We are looking into it.",
    "url": "https://status.example.com/incidents/inc-1"
  },
  "links": {
    "page": "https://status.example.com",
    "event": "https://status.example.com/incidents/inc-1",
    "manage": "https://status.example.com/s/AbCdEfGhIjKl/…"
  }
}
```

Maintenance events carry `maintenance` (`id`, `title`, `description`, `status`,
`scheduledStart`, `scheduledEnd`, `services`, `message`, `url`) instead of
`incident`. `subscription.confirm` carries `confirmationCode`. `links.manage`
only exists for visitor subscriptions.

Headers:

| Header | Value |
| --- | --- |
| `X-OSP-Event` | The event. |
| `X-OSP-Delivery` | The delivery id (`id`); retries keep it, so receivers can de-duplicate. |
| `X-OSP-Timestamp` | Unix time (seconds) of this attempt. |
| `X-OSP-Signature` | `v1=<hex HMAC-SHA256(secret, "<X-OSP-Timestamp>.<raw body>")>` |

Receivers compute the HMAC over the raw body, compare in constant time and
reject timestamps older than 5 minutes. The admin webhook's secret is shown once
(created or rotated); a visitor's generic webhook key is shown on the manage
page. Extra headers of admin webhooks cannot replace `Content-Type` or the
`X-OSP-*` headers.

## SMS

The provider is one HTTP request built from a template (method, URL, headers,
form, JSON or no body, success status codes) with placeholders: `{{to}}` (E.164),
`{{to_digits}}` (without `+`), `{{from}}`, `{{text}}`, `{{username}}`,
`{{password}}` and `{{basic_auth}}` (`base64(username:password)`). Values are
URL-encoded in the URL and in form bodies, JSON-escaped in JSON bodies (put the
placeholder inside a string), and stripped of line breaks in headers. The
credentials are stored encrypted with `SECRET_KEY` and never returned; the
provider URL must be `https://` with a public host.

Presets and their assumptions (public REST APIs as documented in late 2026;
check your account before relying on them):

| Preset | Request | Success |
| --- | --- | --- |
| Twilio | `POST https://api.twilio.com/2010-04-01/Accounts/{{username}}/Messages.json`, Basic auth (Account SID : Auth token), form `To`, `From`, `Body` | `201` |
| Vonage | Messages API `POST https://api.nexmo.com/v1/messages`, Basic auth (API key : API secret), JSON `message_type: "text"`, `channel: "sms"`, `to`/`from` without `+` | `202` |
| seven.io | `POST https://gateway.seven.io/api/sms`, header `X-Api-Key`, form `to`, `from`, `text` | `200` (seven.io also answers 200 for some rejected messages and reports the result code in the body; the delivery log then shows "sent") |
| MessageBird | `POST https://rest.messagebird.com/messages`, header `Authorization: AccessKey …`, JSON `recipients`, `originator`, `body` | `201` |

Budget and pause: SMS that are sent or pending in the current calendar month
(UTC) count against **SMS per month**. When the budget is reached, public SMS
pause: SMS to visitors are no longer queued, new SMS subscriptions are refused,
and the admins get one email per month. Right before sending a subscriber SMS
the worker checks the budget again, counting only the SMS sent so far (the
message itself is still pending); a subscriber SMS queued before the budget ran
out but over it when its turn comes is not sent (status "failed", "Monthly SMS
budget used up"). Neither counts as a failure of the subscriber. On-call SMS still go out. Public SMS subscriptions are off until the
admin lists the allowed countries (calling codes); the list is empty by default.

STOP: OpenStatusPage receives no SMS. Opt-out replies such as `STOP` are handled
by the provider (Twilio blocks further messages to the number, others offer
opt-out lists); the following sends fail, and after 5 messages the provider
rejected (`400`, `410` or `422`) the subscription is removed. Every subscriber SMS carries the unsubscribe link.
