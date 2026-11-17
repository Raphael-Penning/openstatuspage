# Email subscriptions

Visitors of the public page can subscribe to email notifications about public
incidents and maintenance, either for everything or for selected services.
Subscriptions are off until you configure a mail server and enable them.

## Overview

1. Configure a [mail server](#mail-server) through environment variables and
   restart the app.
2. Send a [test email](#test-email).
3. Enable **Email subscriptions** on the settings page and choose the
   [maintenance reminder](#maintenance-reminders).
4. The public page now offers a subscribe form.

The subscribe form only appears when subscriptions are enabled in the settings
**and** a mail transport (`smtp` or `log`) is configured.

## Mail server

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp` when `SMTP_HOST` is set, otherwise `none` | `smtp` sends via SMTP. `log` writes every email to the server log instead of sending it (for development and tests only). `none` disables email. |
| `SMTP_HOST` | – | Host name of the SMTP server or relay. |
| `SMTP_PORT` | `587` | Port of the SMTP server. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465). With `false` the connection is upgraded with STARTTLS when the server offers it. |
| `SMTP_USER` | – | User name for SMTP authentication (optional). |
| `SMTP_PASSWORD` | – | Password for SMTP authentication. |
| `SMTP_FROM` | – | Sender address, required for `smtp` and `log`, e.g. `Example Status <status@example.com>`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` accepts invalid TLS certificates of the SMTP server. Only for internal relays with self-signed certificates; better add your CA with `NODE_EXTRA_CA_CERTS`. |

Example for a mail provider with submission port and STARTTLS:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=status@example.com
SMTP_PASSWORD=<password>
SMTP_FROM="Example Status <status@example.com>"
```

Example for an internal relay without authentication:

```bash
SMTP_HOST=mail-relay.example.com
SMTP_PORT=25
SMTP_FROM="Example Status <status@example.com>"
```

With Docker Compose add the variables to the `environment:` section of the
`openstatuspage` service, then recreate the container
(`docker compose -f docker/docker-compose.yml up -d`).

## Test email

As an administrator open the email status panel on the settings page and send
a test email to your own address. The test is sent immediately (not through
the queue), and the result shows the error message of the mail server if it
fails. When no transport is configured, the test is refused.

## Enabling subscriptions

On the settings page (administrators):

- **Email subscriptions**: offers the subscribe form on the public page.
  Default: off.
- **Maintenance reminder**: hours before a scheduled maintenance at which
  subscribers are reminded (0–168, default 24, 0 = no reminders).

Turning subscriptions off hides the subscribe form on the public page;
existing subscribers are kept.

Before enabling, add a **privacy policy** link to the footer (settings page,
footer links) that explains what the addresses are used for and how long they
are kept.

## How subscribing works

1. The visitor enters an email address, chooses the language (English or
   German) and either **all services** or individual public services (grouped
   like on the public page).
2. OpenStatusPage sends a **confirmation email** (double opt-in). The
   subscription stays inactive until the link in it is clicked.
   Unconfirmed subscriptions are deleted automatically after **7 days**.
3. After confirming, the subscriber gets a link to the **manage page**, where
   they can change their services and language or unsubscribe.

Details that protect subscribers and your mail server:

- The form always answers the same way, whether the address is new, pending
  or already subscribed. Nobody can find out who is subscribed.
- Subscribing again with a pending address re-sends the confirmation; with a
  confirmed address the existing preferences stay unchanged and a "manage your
  subscription" email is sent instead. Such emails go out at most once per
  10 minutes per address.
- The form is rate limited per client IP. Behind a reverse proxy this needs a
  correct `TRUST_PROXY` (see [Reverse proxy](03-reverse-proxy.md#trust_proxy)).
- Links in emails contain a secret token. Tokens are never stored in plain
  text; they are derived from `SECRET_KEY`.
- Every notification email contains a manage link, an unsubscribe link and the
  `List-Unsubscribe` headers for one-click unsubscribe (RFC 8058), which many
  mail clients show as an "Unsubscribe" button.
- Unsubscribing deletes the subscriber completely.

## Who receives what

Emails are sent for **public** incidents and maintenance only, and only when
**Notify subscribers** was ticked (see
[Daily work](06-daily-work.md#the-notify-subscribers-checkbox)):

| Event | Sent when |
| --- | --- |
| New incident, incident update | the checkbox is ticked in that form |
| New maintenance, maintenance update | the checkbox is ticked in that form |
| Maintenance reminder | the maintenance has notifications enabled and a reminder time is set |
| Automatic start / completion | the maintenance has notifications enabled |

Recipients are the confirmed subscribers who chose **all services**, plus
those who selected at least one of the affected **public** services. An event
without public affected services reaches only the "all services" subscribers.

Each email is written in the subscriber's language and contains the site name
in the subject, the title, the status, the message, the affected public
services (never hidden ones), the window in UTC for maintenance, and a link to
the incident or maintenance page.

## Maintenance reminders

With a reminder time of, say, 24 hours, subscribers get a reminder 24 hours
before the scheduled start of each public maintenance with notifications
enabled. Each maintenance is reminded at most once.

## Delivery and the queue

Emails are not sent during the request. They are written to a queue (outbox)
in the database and delivered by the background worker:

- every 10 seconds up to 50 emails are sent;
- failed attempts are retried after 1 minute, 5 minutes, 15 minutes and
  1 hour; after 5 failed attempts an email is marked as **failed**;
- sent and failed entries are removed after 30 days;
- emails to a subscriber who has unsubscribed in the meantime are dropped.

The queue is processed only by an instance with `WORKER_ENABLED=true`. Make
sure exactly one such instance runs.

Problems with the mail server never make saving an incident or maintenance
fail; they show up in the status panel instead.

## Deliverability

Notification emails are only useful if they do not land in spam. For the
domain of `SMTP_FROM`:

- **SPF**: the DNS TXT record of the domain must allow your SMTP server or
  provider, e.g. `v=spf1 include:_spf.mail-provider.example -all`.
- **DKIM**: let the mail server or provider sign outgoing mail and publish the
  public key in DNS. OpenStatusPage does not sign mail itself.
- **DMARC**: publish a policy, e.g.
  `_dmarc.example.com TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"`,
  and make sure SPF or DKIM align with the From domain.
- Use a sender address on a domain you control, ideally a subdomain such as
  `status.example.com`, and do not send from a free-mail address.
- If you run your own mail server, it needs a matching reverse DNS (PTR)
  record and should not be on a blocklist.

The one-click unsubscribe headers that large mailbox providers require for
bulk senders are already included.

## Subscribers and privacy

Administrators see the list of subscribers (address, language, services,
confirmed or pending) and can delete a subscriber. Deleting is logged in the
audit log with the address masked. Editors have no access to addresses.

What is stored per subscriber: email address, language, selected services,
time of subscription and confirmation. Nothing else, no tracking pixels, no
link tracking.

## Troubleshooting

The **email status panel** on the settings page shows:

- the transport (`smtp`, `log` or `none`) and the sender address,
- the number of confirmed and pending subscribers,
- the queue: pending and failed emails,
- when the last email was sent, and the last error with its time.

| Symptom | Check |
| --- | --- |
| No subscribe form on the public page | Subscriptions enabled in the settings? Transport `smtp` or `log`? |
| Transport shows `none` | `SMTP_HOST` or `MAIL_TRANSPORT` not set in the container environment; restart after changing variables. |
| Test email fails | The error in the panel comes from the mail server: wrong port/`SMTP_SECURE` combination, wrong credentials, sender not allowed, TLS certificate not trusted. |
| Test works, notifications do not arrive | Pending count growing? Then no instance runs the worker (`WORKER_ENABLED`). Was **Notify subscribers** ticked and the incident public? Is the subscriber confirmed and subscribed to an affected service? |
| Failed emails in the queue | Fix the cause shown as last error, then use **Retry failed** to queue them again. |
| Emails land in spam | See [Deliverability](#deliverability). |
| Links in emails do not work | `BASE_URL` wrong, or `SECRET_KEY` changed since the email was sent. |

For development set `MAIL_TRANSPORT=log` and `SMTP_FROM`: emails then appear
in the server log instead of being sent.
