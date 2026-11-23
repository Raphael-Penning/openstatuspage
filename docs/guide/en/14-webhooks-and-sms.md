# Webhooks and SMS

Besides email, OpenStatusPage can post incidents and maintenance to chat
channels and your own endpoints (webhooks) and send them as text messages
(SMS): to your team, and, if you allow it, to visitors who subscribe on the
public page. Everything is configured in the management UI under
**Administration → Webhooks & SMS**. No extra environment variable is needed;
the secrets are encrypted (see [Configuration](../../configuration.md#webhooks-and-sms)).

Webhooks and SMS get the same events as the email subscribers: a new or updated
public incident or maintenance when the editor leaves **Notify subscribers**
on, the automatic start and end of a maintenance window, and the maintenance
reminder. Private incidents and hidden services are never sent.

## Team webhooks

1. Open **Webhooks & SMS** and choose **Add webhook**.
2. Choose the type and paste the URL:
   - **Discord**: Server settings > Integrations > Webhooks > New webhook >
     Copy webhook URL.
   - **Slack**: an app with *Incoming Webhooks*; copy the webhook URL of the
     channel.
   - **Microsoft Teams**: in the channel, **Workflows** > *Post to a channel
     when a webhook request is received*; copy the URL the workflow shows. The
     message is an Adaptive Card. The retired Office 365 connectors are not
     supported.
   - **Generic JSON**: any https endpoint of your own. The answer to the
     creation shows the **signing secret once**; copy it into the receiving
     system (see [Verifying generic webhooks](#verifying-generic-webhooks)).
     You can add extra headers (for example an `Authorization` header); their
     values are stored encrypted.
3. Choose **All services** or the services the webhook is for.
4. Save, then send a test message with the test button in the row of the
   webhook.

The URL is write-only: the list only shows its host, because the path of
Discord, Slack and Teams URLs is the secret. To change it, enter the whole URL
again.

The **delivery log** button of the row opens the log of the deliveries (time,
event, status, HTTP status code or error, never the URL or the message). Failed deliveries are retried
after 1, 5, 15 and 60 minutes; a `4xx` answer (other than 408, 425 and 429) is
not retried. After **10 failed deliveries in a row** a webhook is disabled, the
reason is shown in the list and every admin gets an email (when a mail server
is configured). Enable it again once the endpoint works.

`http://` URLs are refused unless you tick **Allow http://** for a webhook.
Whatever you allow, the server never connects to private, loopback or
link-local addresses, follows no redirects and gives up after 10 seconds.

## SMS

### Provider

SMS go out with one HTTP request built from a template. Choose a **preset**
(Twilio, Vonage, seven.io, MessageBird) to fill the template, then enter the
sender and the credentials:

| Preset | Credential 1 | Credential 2 | Sender |
| --- | --- | --- | --- |
| Twilio | Account SID | Auth token | A Twilio number in international format |
| Vonage (Messages API) | API key | API secret | A number or an alphanumeric sender your account may use |
| seven.io | – | API key | Number or name |
| MessageBird | – | Access key | Number or name |

Credentials are stored encrypted and never shown again; leave the field empty to
keep them. With **Custom** you describe the request yourself: method, URL,
headers, a form or JSON body and the status codes that mean success. The
placeholders `{{to}}`, `{{to_digits}}` (without `+`), `{{from}}`, `{{text}}`,
`{{username}}`, `{{password}}` and `{{basic_auth}}` are filled in for every SMS.
The [notifications reference](../../webhooks-and-sms.md#sms) lists what each preset
assumes about the provider's API.

Send a test SMS before you rely on it. Every SMS is a single segment: texts are
shortened to 160 GSM-7 characters (70 with characters outside GSM-7).

### On-call numbers

Under **On-call SMS recipients** add the numbers of your team in international
format (`+49 151 2345678`), for all services or selected ones. They get every
event of their services, also after the monthly budget is used up.

## Visitor subscriptions

In **Visitor subscriptions and limits**:

- **Discord, Slack and Teams webhooks**: visitors may subscribe with the
  official webhook URLs of these services.
- **Generic webhooks**: off by default. Turn it on only if any https endpoint on
  the internet may receive your notifications.
- **Countries for SMS subscriptions**: the calling codes (`49, 43, 41`) whose
  numbers may subscribe. Empty (the default) means no SMS subscriptions.
- **SMS per month**: when the budget is reached, SMS to visitors and new SMS
  subscriptions pause until the next month, and the admins get an email.
- The rate limits per minute and hour. With the defaults, visitors' webhooks go
  out at 60 per minute and SMS at 30 per minute; your own webhooks and on-call
  SMS never wait behind them.

The subscribe page (`/subscribe`) then links to **Webhook** and **SMS**. A
visitor enters the URL or number and gets a message with a **6-digit code**;
the subscription starts once the code is entered on the page (valid 24 hours,
5 attempts). Every message carries a short link to manage or cancel the
subscription. Everything works without JavaScript.

Subscribers of every channel are listed under **Subscribers** (switch the
channel at the top). Unconfirmed subscriptions are removed after 7 days, and a
subscriber whose destination refused the last five messages (a deleted webhook,
a number your provider rejects) is removed automatically. Problems on your side,
such as a used-up budget, wrong provider credentials or a network outage, never
remove subscribers.

### STOP replies

OpenStatusPage does not receive SMS. Replies such as `STOP` are handled by your
provider: Twilio, for example, blocks further messages to a number that replied
`STOP`. Those sends then fail, and after five rejected messages the
subscription is removed. Every SMS also carries the unsubscribe link.

## Verifying generic webhooks

Generic webhooks send JSON (`"version": 1`, see the
[notifications reference](../../webhooks-and-sms.md#generic-json-payload)) with
these headers:

- `X-OSP-Timestamp`: Unix time in seconds.
- `X-OSP-Signature`: `v1=` and the hex HMAC-SHA256 of `<timestamp>.<body>`
  with the signing secret.

Compute the HMAC over the raw body, compare it in constant time, and reject
timestamps older than five minutes. Visitors with a generic webhook find their
key on their manage page.
