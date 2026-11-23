# Webhooks and SMS

Besides email ([notifications.md](notifications.md)), notifications go to
webhooks (Discord, Slack, Microsoft Teams, generic JSON) and by SMS: to
admin-configured destinations and, when the admin allows it, to visitors. The
guide chapter [Webhooks and SMS](guide/en/13-webhooks-and-sms.md) explains the
set-up; this page is the reference.

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
