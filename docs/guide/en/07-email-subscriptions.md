# Email subscriptions

Visitors of the public page can subscribe to email notifications about public
incidents and maintenance, either for all updates or for selected services.
Subscriptions are off until you configure a mail server and enable them.

## Overview

1. Configure a [mail server](#mail-server) through environment variables and
   restart the app.
2. Send a [test email](#test-email).
3. On the settings page, in the **Email subscriptions** section, turn on
   **Offer email subscriptions**, choose the
   [maintenance reminder](#maintenance-reminders) and save.
4. The **Subscribe to updates** menu on the public page now has an
   **Email notifications** entry that leads to the subscribe form
   (`/subscribe`).

The entry only appears when subscriptions are enabled in the settings
**and** a mail transport (`smtp` or `log`) is configured. If you enable
subscriptions without a transport, the settings page shows a warning.

## Mail server

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp` when `SMTP_HOST` is set, otherwise `none` | `smtp` sends via SMTP. `log` writes every email to the server log instead of sending it (for development and tests only: the log then contains the links of confirmation and manage emails). `none` disables email, even when `SMTP_HOST` is set. |
| `SMTP_HOST` | – | Host name of the SMTP server or relay. Required for `smtp`. |
| `SMTP_PORT` | `587` | Port of the SMTP server. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465). With `false` the connection is upgraded with STARTTLS when the server offers it. |
| `SMTP_USER` | – | User name for SMTP authentication. Leave it empty for relays without authentication. |
| `SMTP_PASSWORD` | – | Password for SMTP authentication. |
| `SMTP_FROM` | – | Sender address, required for `smtp` and `log`, e.g. `Example Status <status@example.com>`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` accepts invalid TLS certificates of the SMTP server. Only for internal relays with self-signed certificates; better add your CA with `NODE_EXTRA_CA_CERTS`. |

The server refuses to start when `SMTP_FROM` is missing or not an email
address (with `smtp` or `log`), or when `MAIL_TRANSPORT=smtp` is set without
`SMTP_HOST`. The start-up error names the variable.

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

With Docker Compose put the variables into `.env` next to `compose.yaml`
(the template has a mail section, see
[Installation](02-installation.md#settings-in-env)); you do not need to edit
`compose.yaml`. Then recreate the container with `docker compose up -d`.
Quote `SMTP_FROM` when it contains spaces or angle brackets, and wrap an
`SMTP_PASSWORD` that contains `$` in single quotes.
On Kubernetes add the variables to the secret `openstatuspage` and restart
the pod with `kubectl -n openstatuspage rollout restart deployment/openstatuspage`.

## Test email

As an administrator open the settings page. The **Email delivery** panel in
the **Email subscriptions** section has the field **Send a test email to**:
enter your own address and click **Send test email**. The test is sent
immediately (not through the queue) in the default language of the page. The
result appears below the buttons; if sending fails, it shows the error
message of the mail server. Without a configured transport the button is
disabled. With `MAIL_TRANSPORT=log` the test email is written to the server
log.

## Enabling subscriptions

On the settings page (administrators), section **Email subscriptions**:

- **Offer email subscriptions**: offers subscriptions on the public page.
  Default: off.
- **Maintenance reminder (hours)**: hours before a scheduled maintenance at
  which subscribers are reminded (0–168, default 24, 0 = no reminders).

Turning **Offer email subscriptions** off removes the entry from the public
page, and the subscribe page then says that email notifications are not
available. While it is off, **no notification emails** are sent at all
(neither for incidents and maintenance nor reminders or automatic start and
completion); emails that are already queued are still delivered. Existing
subscribers are kept, and the links in their emails keep working, so they can
still change their preferences or unsubscribe.

Before enabling, add a **privacy policy** link to the footer (settings page,
**Footer links**) that explains what the addresses are used for and how long
they are kept.

## How subscribing works

1. The visitor opens **Subscribe to updates → Email notifications**, enters an
   email address, chooses the **Email language** (English or German) and
   either **All updates** or **Selected services** (only public services,
   grouped like on the public page).
2. OpenStatusPage sends a **confirmation email** (double opt-in). The
   subscription stays inactive until the link in it is clicked.
   Unconfirmed subscriptions are deleted automatically after **7 days**
   (counted from the last confirmation email).
3. After confirming, the page offers **Manage preferences**. Every
   notification email also contains a link to this manage page, where the
   subscriber can change the services and language or unsubscribe.

Details that protect subscribers and your mail server:

- The form always answers the same way and equally fast, whether the address
  is new, pending or already subscribed. Nobody can find out who is subscribed.
- Subscribing again never changes the choices of an existing address. A
  pending address gets the confirmation again (the choices can be changed on
  the manage page after confirming); a confirmed address gets a "manage your
  subscription" email with the manage link instead. Such emails go out at
  most once per 10 minutes per address.
- The form is limited to 5 requests per minute per client IP, the confirm,
  manage and unsubscribe links to 30 per minute. Behind a reverse proxy this
  needs a correct `TRUST_PROXY` (see
  [Reverse proxy](03-reverse-proxy.md#trust_proxy)).
- Links in emails contain a secret token. Tokens are never stored, not even
  in the email queue; they are derived from `SECRET_KEY` and a random value
  per subscriber when an email is sent. The token is part of the link's `#`
  fragment, which browsers never send to the server, so it does not show up
  in server or proxy logs.
- Every notification email contains a manage link and an unsubscribe link.
  The unsubscribe link opens the manage page with the unsubscribe question
  already shown, so one more click on **Yes, unsubscribe** is enough.
- Notification emails also carry the `List-Unsubscribe` and
  `List-Unsubscribe-Post` headers for one-click unsubscribe (RFC 8058). Many
  mail clients show them as an "Unsubscribe" button that unsubscribes
  directly, without opening the page. Opening that address in a browser only
  leads to the manage page and never unsubscribes by itself.
- Unsubscribing deletes the subscriber completely, including emails still
  waiting in the queue.

## Who receives what

Emails are sent for **public** incidents and maintenance only, only while
email subscriptions are enabled, and only when **Notify subscribers** was
ticked (see
[Daily work](06-daily-work.md#the-notify-subscribers-checkbox)):

| Event | Sent when |
| --- | --- |
| New incident | the checkbox is ticked in **New incident** |
| Incident update | the checkbox is ticked in **Post update** or **Resolve** |
| New maintenance (announcement) | the checkbox is ticked in **Schedule maintenance** |
| Maintenance update | the checkbox is ticked in **Post update**, **Start now**, **Complete** or **Cancel maintenance** |
| Maintenance reminder | the maintenance has notifications enabled and the reminder is not 0, see [Maintenance reminders](#maintenance-reminders) |
| Automatic start / completion | the maintenance has notifications enabled |

"Notifications enabled" is the choice stored with the maintenance when it was
scheduled; you can change it in **Edit maintenance**. Editing an incident,
a maintenance or an existing update never sends an email.

Recipients are the confirmed subscribers with **All updates**, plus those who
selected at least one of the affected **public** services. An event without
public affected services reaches only the "All updates" subscribers.

Each email is written in the subscriber's language and contains the site name
in the subject, the title, the status, the message, the affected public
services (never hidden ones), the impact for incidents, the window in UTC for
maintenance, and a link to the incident or maintenance page. Automatic start
and completion emails use a standard sentence such as "The maintenance has
started."

## Maintenance reminders

With a reminder time of, say, 24 hours, subscribers get a reminder 24 hours
before the scheduled start of each public maintenance with notifications
enabled. The worker checks once a minute.

- Each maintenance is reminded at most once. Its detail page shows when the
  reminder was queued.
- A maintenance scheduled less than 24 hours before its start gets no
  reminder: the announcement has just been sent.
- If you move the start to a later time, subscribers are reminded again
  before the new start.
- Only maintenance that is still *Scheduled* is reminded.
- Setting the reminder to 0 turns reminders off for all maintenance.

## Delivery and the queue

Emails are not sent during the request. They are written to a queue (outbox)
in the database and delivered by the background worker:

- new emails are sent right away; in addition the worker checks the queue
  every 10 seconds and sends due emails in batches of 50;
- failed attempts are retried after 1 minute, 5 minutes, 15 minutes and
  1 hour; after 5 failed attempts an email is marked as **failed**;
- sent and failed entries are removed after 30 days;
- emails to a subscriber who has unsubscribed or was deleted in the meantime
  are dropped.

The queue is processed only by an instance with `WORKER_ENABLED=true`. Make
sure exactly one such instance runs; without it, emails stay queued.

Problems with the mail server never make saving an incident or maintenance
fail; they show up in the **Email delivery** panel instead.

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
- Set `BASE_URL` to the real public URL: every link in the emails uses it.

The one-click unsubscribe headers that large mailbox providers require for
bulk senders are already included.

## Subscribers and privacy

**Administration → Subscribers** (administrators only) lists all subscribers
with address, status (*Confirmed* or *Pending*), what they subscribed to
(**All updates** or the selected services), language and the dates of
subscribing and confirming. You can search by address, filter by status and
delete a subscriber. Deleting cannot be undone; the address receives no
further emails and queued emails are dropped. Deleting a subscriber, sending
a test email and **Retry failed** are recorded in the audit log; addresses
appear there only masked (`j***@example.com`). Editors have no access to
addresses.

What is stored per subscriber: email address, language, **All updates** or
the selected services, the times of subscribing, confirming and the last
confirmation email, and a random value from which the link tokens are
derived. The queue keeps the emails themselves (recipient, subject, text) for
at most 30 days. Nothing else: no tracking pixels, no link tracking.

## Troubleshooting

The **Email delivery** panel on the settings page shows:

- **Transport** (*SMTP*, *Server log* or *Not configured*) and **Sender**,
- **Subscribers**: the number of confirmed and pending subscribers,
- **Queue**: pending and failed emails,
- **Last sent**, and **Last error** with its time.

| Symptom | Check |
| --- | --- |
| No **Email notifications** entry on the public page | **Offer email subscriptions** turned on and saved? Transport not *Not configured*? |
| Transport shows *Not configured* | `SMTP_HOST` or `MAIL_TRANSPORT` does not reach the server (with Compose: is the variable in the env file you pass, or exported?); restart after changing variables. |
| Test email fails | The error below the button comes from the mail server: wrong port/`SMTP_SECURE` combination, wrong credentials, sender not allowed, TLS certificate not trusted. |
| Test works, notifications do not arrive | Pending count growing? Then no instance runs the worker (`WORKER_ENABLED`). Was **Notify subscribers** ticked, the incident or maintenance public and **Offer email subscriptions** on? Is the subscriber confirmed and subscribed to **All updates** or an affected public service? |
| No maintenance reminder | Notifications enabled for the maintenance (detail page)? Reminder set to 0? Scheduled less than the reminder time before its start? |
| Failed emails in the queue | Fix the cause shown as **Last error**, then use **Retry failed** to queue them again. |
| Emails land in spam | See [Deliverability](#deliverability). |
| Links in emails do not work | `BASE_URL` wrong, `SECRET_KEY` changed since the email was sent, or the unconfirmed subscription was already deleted after 7 days. |

For development set `MAIL_TRANSPORT=log` and `SMTP_FROM`: emails then appear
in the server log instead of being sent.
