/**
 * Subscriber notifications and the mail outbox.
 *
 * Fan-out: incident/maintenance events create one outbox row per recipient
 * (after the request's DB transaction). Only PUBLIC incidents and maintenance
 * notify, and mails only name PUBLIC services. Recipients are confirmed
 * subscribers with "all services" plus those subscribed to at least one
 * affected public service.
 *
 * Tokens: subscriber mails are queued with TOKEN_PLACEHOLDERS instead of the
 * confirm/manage tokens. deliverOne derives the real tokens (SUBSCRIPTION_TOKEN_KEY +
 * subscriber id + token_salt) right before sending, so the outbox never holds
 * a token. Once a row is sent, its bodies and headers are blanked; subject,
 * kind and status stay for the status view.
 *
 * Delivery: a worker task sends due rows in batches and retries failures with
 * backoff (1 min, 5 min, 15 min, 1 h); only a failed send is retried, not a
 * database error after the transport accepted the mail (if marking it sent keeps
 * failing, the row is due again once its claim expires, so the mail can go out
 * once more). After MAX_ATTEMPTS a row is marked failed
 * (and keeps its placeholder bodies, so an admin can retry it). Email addresses
 * in SMTP errors are masked before they are logged or stored. Sent and failed
 * rows are purged after OUTBOX_RETENTION_MS. Mails of a deleted subscriber are
 * dropped (foreign key cascade, and at delivery time).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { NotificationStatus } from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { OutboxRow } from '../db/types.js';
import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { mailerConfigured, type Mailer } from '../mail/mailer.js';
import {
  confirmationMail,
  incidentMail,
  manageMail,
  maintenanceMail,
  stripTokenPlaceholders,
  testMail,
  type MailSite,
  type MaintenanceMailKind,
  type RenderedMail,
} from '../mail/templates.js';
import type { Worker } from '../worker.js';
import type { ChannelEvent, ChannelEventType } from './channels/messages.js';
import type { ChannelService } from './channels/service.js';
import { loadIncident } from './incidents.js';
import { loadMaintenance } from './maintenances.js';
import { getSettings } from './settings.js';
import {
  fillTokens,
  maskEmailsIn,
  purgeUnconfirmed,
  subscriberLinks,
  subscriberTokens,
  TOKEN_PLACEHOLDERS,
  unsubscribeHeaders,
  type SubscriberLinkSet,
} from './subscriptions.js';

export const DELIVERY_TASK = 'email-delivery';
export const DELIVERY_INTERVAL_MS = 10_000;
export const DELIVERY_BATCH = 50;
export const MAX_ATTEMPTS = 5;
/** Wait before attempt n+1 after n failed attempts (index n-1). */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const OUTBOX_RETENTION_MS = 30 * 86400_000;
/** A row being sent is hidden from other runs for this long (crash safety). */
const CLAIM_MS = 10 * 60_000;
/** Tries to mark a sent row as sent (database errors after the transport accepted it). */
const MARK_SENT_ATTEMPTS = 3;
const MARK_SENT_RETRY_MS = 200;
const HOUR_MS = 3600_000;
/** Rows per INSERT statement (stays far below SQLite's variable limit). */
const INSERT_CHUNK = 100;

export interface OutboxMail extends RenderedMail {
  subscriberId: string | null;
  recipient: string;
  /** confirm, manage, incident, maintenance, maintenance_reminder */
  kind: string;
  headers?: Record<string, string>;
}

interface Recipient {
  id: string;
  email: string;
  locale: 'en' | 'de';
}

export interface DeliveryResult {
  sent: number;
  retried: number;
  failed: number;
}

const BASE_HEADERS = { 'Auto-Submitted': 'auto-generated' };

/**
 * A recipient must be exactly one plain address (the rule of the subscribe form). Rows
 * written through the database functions of the public role are checked again here.
 */
const Recipient = z.email().max(254);

/**
 * A confirmation or "manage" mail queued without content. The database functions of
 * the restricted public role (0007_public_role) queue them like this, so a public
 * instance can never decide what a mail says; the worker renders them before sending.
 */
function isUnrenderedAccountMail(row: OutboxRow): boolean {
  return (row.kind === 'confirm' || row.kind === 'manage') && row.text_body === '' && row.html_body === '';
}

export class NotificationService {
  /** Current time; replaced in tests. */
  clock: () => Date = () => new Date();
  /** Webhook and SMS channels: get every event that would send subscriber mails (set by createContext). */
  channels?: ChannelService;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    readonly mailer: Mailer,
    private readonly log: FastifyBaseLogger,
    private readonly worker?: Worker,
  ) {}

  /** Runs a fan-out; errors are logged and never propagate (admin requests must not fail). */
  async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error({ err, notification: what }, 'subscriber notification failed');
    }
  }

  /**
   * Inserts mails into the outbox and triggers delivery. Subscriber mails must be
   * rendered with TOKEN_PLACEHOLDERS, never with real tokens.
   */
  async enqueue(mails: OutboxMail[], now = this.clock()): Promise<void> {
    if (mails.length === 0) return;
    const nowIso = now.toISOString();
    for (let i = 0; i < mails.length; i += INSERT_CHUNK) {
      await this.db
        .insertInto('email_outbox')
        .values(
          mails.slice(i, i + INSERT_CHUNK).map((m) => ({
            id: newId(),
            subscriber_id: m.subscriberId,
            recipient: m.recipient,
            kind: m.kind,
            subject: m.subject,
            text_body: m.text,
            html_body: m.html,
            headers: JSON.stringify({ ...BASE_HEADERS, ...(m.headers ?? {}) }),
            status: 'pending' as const,
            attempts: 0,
            next_attempt_at: nowIso,
            last_error: null,
            last_attempt_at: null,
            created_at: nowIso,
            sent_at: null,
          })),
        )
        .execute();
    }
    // Send right away instead of waiting for the next tick (no-op without worker).
    if (this.worker?.has(DELIVERY_TASK)) void this.worker.runNow(DELIVERY_TASK);
  }

  /** Queues an event for the webhook and SMS channels; a failure there never stops the mails. */
  private async publishToChannels(event: ChannelEvent, publicServiceIds: string[]): Promise<void> {
    if (!this.channels) return;
    try {
      await this.channels.publish(event, publicServiceIds);
    } catch (err) {
      this.log.error({ err, event: event.type }, 'webhook and SMS notifications failed');
    }
  }

  /** Site data for templates, or null when notifications are off (setting or no transport). */
  private async site(): Promise<{ site: MailSite; reminderHours: number } | null> {
    if (!mailerConfigured(this.mailer)) return null;
    const settings = await getSettings(this.db);
    if (!settings.emailSubscriptionsEnabled) return null;
    return {
      site: { siteName: settings.siteName, baseUrl: this.config.PUBLIC_BASE_URL, accentColor: settings.accentColor },
      reminderHours: settings.maintenanceReminderHours,
    };
  }

  /** Confirmed subscribers for an event affecting `publicServiceIds`. */
  async recipients(publicServiceIds: string[]): Promise<Recipient[]> {
    return this.db
      .selectFrom('subscribers')
      .select(['id', 'email', 'locale'])
      .where('confirmed_at', 'is not', null)
      .where((eb) =>
        publicServiceIds.length === 0
          ? eb('all_services', '=', 1)
          : eb.or([
              eb('all_services', '=', 1),
              eb.exists(
                eb
                  .selectFrom('subscriber_services')
                  .select('subscriber_services.subscriber_id')
                  .whereRef('subscriber_services.subscriber_id', '=', 'subscribers.id')
                  .where('subscriber_services.service_id', 'in', publicServiceIds),
              ),
            ]),
      )
      .orderBy('created_at')
      .execute();
  }

  private async fanOut(
    kind: string,
    publicServiceIds: string[],
    render: (r: Recipient, links: SubscriberLinkSet) => RenderedMail,
  ): Promise<number> {
    const recipients = await this.recipients(publicServiceIds);
    const mails = recipients.map((r): OutboxMail => {
      // Placeholders only: deliverOne fills in the real tokens right before sending.
      const links = subscriberLinks(this.config, r.id, TOKEN_PLACEHOLDERS);
      return {
        subscriberId: r.id,
        recipient: r.email,
        kind,
        headers: unsubscribeHeaders(links),
        ...render(r, links),
      };
    });
    await this.enqueue(mails);
    if (mails.length > 0) this.log.info({ kind, recipients: mails.length }, 'subscriber notifications queued');
    return mails.length;
  }

  /**
   * Notifies subscribers about the latest update of an incident.
   * Call only when the editor asked for it (`notify`). Private incidents never notify.
   */
  async incidentPosted(incidentId: string, opts: { isNew: boolean }): Promise<number> {
    const rec = await loadIncident(this.db, incidentId);
    if (!rec || rec.row.is_public !== 1) return 0;
    const latest = rec.updates[0];
    const services = rec.services.filter((s) => s.isPublic);
    const status = latest?.status ?? rec.row.status;
    await this.publishToChannels(
      {
        type: opts.isNew ? 'incident.created' : status === 'resolved' ? 'incident.resolved' : 'incident.updated',
        occurredAt: this.clock().toISOString(),
        incident: {
          id: rec.row.id,
          title: rec.row.title,
          status,
          impact: rec.row.impact,
          services: services.map((s) => s.name),
          message: stripTokenPlaceholders(latest?.message ?? ''),
        },
      },
      services.map((s) => s.id),
    );
    const ctx = await this.site();
    if (!ctx) return 0;
    return this.fanOut(
      'incident',
      services.map((s) => s.id),
      (r, links) =>
        incidentMail(
          ctx.site,
          r.locale,
          {
            id: rec.row.id,
            title: rec.row.title,
            status: latest?.status ?? rec.row.status,
            impact: rec.row.impact,
            services: services.map((s) => s.name),
            message: latest?.message ?? '',
            isNew: opts.isNew,
          },
          links,
        ),
    );
  }

  /**
   * Notifies subscribers about a maintenance: the announcement (`scheduled`), the latest
   * update (`update`) or the `reminder`. With `requireStoredFlag` (automatic transitions,
   * reminders) the maintenance's own notify flag must be set.
   */
  async maintenanceEvent(
    maintenanceId: string,
    kind: MaintenanceMailKind,
    opts: { requireStoredFlag?: boolean } = {},
  ): Promise<number> {
    const rec = await loadMaintenance(this.db, maintenanceId);
    if (!rec || rec.row.is_public !== 1) return 0;
    if (opts.requireStoredFlag && rec.row.notify_subscribers !== 1) return 0;
    // Newest update matching the current status (automatic start+complete share one timestamp).
    const latest = rec.updates.find((u) => u.status === rec.row.status) ?? rec.updates[0];
    const services = rec.services.filter((s) => s.isPublic);
    await this.publishToChannels(
      {
        type: maintenanceEventType(kind, rec.row.status),
        occurredAt: this.clock().toISOString(),
        maintenance: {
          id: rec.row.id,
          title: rec.row.title,
          description: rec.row.description,
          status: rec.row.status,
          scheduledStart: rec.row.scheduled_start,
          scheduledEnd: rec.row.scheduled_end,
          services: services.map((s) => s.name),
          message: kind === 'update' ? stripTokenPlaceholders(latest?.message ?? '') : '',
        },
      },
      services.map((s) => s.id),
    );
    const ctx = await this.site();
    if (!ctx) return 0;
    return this.fanOut(
      kind === 'reminder' ? 'maintenance_reminder' : 'maintenance',
      services.map((s) => s.id),
      (r, links) =>
        maintenanceMail(
          ctx.site,
          r.locale,
          kind,
          {
            id: rec.row.id,
            title: rec.row.title,
            description: rec.row.description,
            status: rec.row.status,
            scheduledStart: rec.row.scheduled_start,
            scheduledEnd: rec.row.scheduled_end,
            services: services.map((s) => s.name),
            message: kind === 'update' ? (latest?.message ?? '') : '',
          },
          links,
        ),
    );
  }

  /**
   * Queues reminders for public maintenance with notify flag starting within
   * settings.maintenanceReminderHours. Each window is reminded once (reminder_sent_at);
   * windows created inside the reminder period are not reminded (the announcement is recent).
   */
  async sendDueReminders(now = new Date()): Promise<number> {
    // Reminders also go to the webhook and SMS channels: they do not depend on email being set up.
    const reminderHours = (await getSettings(this.db)).maintenanceReminderHours;
    if (reminderHours <= 0) return 0;
    const periodMs = reminderHours * HOUR_MS;
    const nowIso = now.toISOString();
    const horizon = new Date(now.getTime() + periodMs).toISOString();
    const due = await this.db
      .selectFrom('maintenances')
      .select(['id', 'scheduled_start', 'created_at'])
      .where('status', '=', 'scheduled')
      .where('is_public', '=', 1)
      .where('notify_subscribers', '=', 1)
      .where('reminder_sent_at', 'is', null)
      .where('scheduled_start', '>', nowIso)
      .where('scheduled_start', '<=', horizon)
      .execute();
    let reminded = 0;
    for (const m of due) {
      const periodStart = new Date(new Date(m.scheduled_start).getTime() - periodMs).toISOString();
      if (m.created_at > periodStart) continue;
      // Claim first, so a concurrent run cannot remind twice.
      const claimed = await this.db
        .updateTable('maintenances')
        .set({ reminder_sent_at: nowIso })
        .where('id', '=', m.id)
        .where('reminder_sent_at', 'is', null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) continue;
      await this.maintenanceEvent(m.id, 'reminder', { requireStoredFlag: true });
      reminded++;
    }
    return reminded;
  }

  /**
   * Sends due outbox rows. `now` (the batch start) only selects the due rows; claims,
   * backoff and timestamps use the current time of each row, since sending a batch
   * can take a while. Does nothing without a transport (rows stay pending).
   */
  async deliverDue(now = this.clock(), limit = DELIVERY_BATCH): Promise<DeliveryResult> {
    const result: DeliveryResult = { sent: 0, retried: 0, failed: 0 };
    if (!mailerConfigured(this.mailer)) return result;
    const rows = await this.db
      .selectFrom('email_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', now.toISOString())
      .orderBy('next_attempt_at')
      .orderBy('created_at')
      .limit(limit)
      .execute();

    for (const row of rows) {
      const claimedAt = this.clock();
      const claimed = await this.db
        .updateTable('email_outbox')
        .set({ next_attempt_at: new Date(claimedAt.getTime() + CLAIM_MS).toISOString() })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('next_attempt_at', '=', row.next_attempt_at)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) continue;
      await this.deliverOne(row, result);
    }
    if (result.sent + result.retried + result.failed > 0) this.log.debug({ ...result }, 'email outbox processed');
    return result;
  }

  /**
   * Bodies and headers of a row with the subscriber's real tokens filled in (derived
   * here, never stored). Rows without subscriber are used as they are. Returns null
   * when the subscriber no longer exists.
   */
  private async prepare(
    row: OutboxRow,
  ): Promise<{ subject: string; text: string; html: string; headers?: string } | null> {
    const headers = row.headers ?? undefined;
    if (row.subscriber_id === null) return { subject: row.subject, text: row.text_body, html: row.html_body, headers };
    const sub = await this.db
      .selectFrom('subscribers')
      .select(['id', 'token_salt', 'locale'])
      .where('id', '=', row.subscriber_id)
      .executeTakeFirst();
    if (!sub) return null;
    const tokens = subscriberTokens(this.config, sub);
    let { subject, text_body: text, html_body: html } = row;
    if (isUnrenderedAccountMail(row)) {
      // Queued by the database function of the public role, which never takes mail content.
      const settings = await getSettings(this.db);
      const site = { siteName: settings.siteName, baseUrl: this.config.PUBLIC_BASE_URL, accentColor: settings.accentColor };
      const links = subscriberLinks(this.config, sub.id, TOKEN_PLACEHOLDERS);
      const mail =
        row.kind === 'confirm'
          ? confirmationMail(site, sub.locale, links.confirmUrl)
          : manageMail(site, sub.locale, links.manageUrl);
      ({ subject, text, html } = mail);
    }
    return {
      subject,
      text: fillTokens(text, tokens),
      html: fillTokens(html, tokens),
      headers: headers === undefined ? undefined : fillTokens(headers, tokens),
    };
  }

  private async deliverOne(row: OutboxRow, result: DeliveryResult): Promise<void> {
    const attempts = row.attempts + 1;
    if (!Recipient.safeParse(row.recipient).success) {
      // Never retried: the address does not change.
      await this.db
        .updateTable('email_outbox')
        .set({ status: 'failed', attempts, last_error: 'Invalid recipient address', last_attempt_at: this.clock().toISOString() })
        .where('id', '=', row.id)
        .execute();
      this.log.warn({ outboxId: row.id, kind: row.kind }, 'email not sent: invalid recipient address');
      result.failed++;
      return;
    }
    const mail = await this.prepare(row);
    if (!mail) {
      await this.db.deleteFrom('email_outbox').where('id', '=', row.id).execute();
      return;
    }
    try {
      await this.mailer.send({
        to: row.recipient,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: mail.headers ? (JSON.parse(mail.headers) as Record<string, string>) : undefined,
      });
    } catch (err) {
      const at = this.clock();
      // SMTP errors often quote the recipient: mask addresses before logging and storing.
      const message = maskEmailsIn(err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const failed = attempts >= MAX_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;
      await this.db
        .updateTable('email_outbox')
        .set({
          status: failed ? 'failed' : 'pending',
          attempts,
          last_error: message,
          last_attempt_at: at.toISOString(),
          next_attempt_at: failed ? at.toISOString() : new Date(at.getTime() + backoff).toISOString(),
        })
        .where('id', '=', row.id)
        .execute();
      // No recipient address in the log.
      this.log.warn({ outboxId: row.id, kind: row.kind, attempts, failed, error: message }, 'email delivery failed');
      if (failed) result.failed++;
      else result.retried++;
      return;
    }
    // Accepted by the transport: the mail is sent. A database error from here on must not
    // count as a delivery failure, whose retry would send it again.
    result.sent++;
    await this.markSent(row, mail.subject, attempts);
  }

  /**
   * Marks a row sent and blanks its bodies and headers (subject, kind and status stay
   * for the status view). Tries a few times; if the database stays unavailable the
   * error is logged and the row keeps its claim (CLAIM_MS) before it is due again.
   */
  private async markSent(row: OutboxRow, subject: string, attempts: number): Promise<void> {
    const sentAt = this.clock().toISOString();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.db
          .updateTable('email_outbox')
          .set({
            status: 'sent',
            // Rows queued without content get the subject they were sent with.
            subject,
            attempts,
            sent_at: sentAt,
            last_attempt_at: sentAt,
            last_error: null,
            text_body: '',
            html_body: '',
            headers: null,
          })
          .where('id', '=', row.id)
          .execute();
        return;
      } catch (err) {
        if (attempt >= MARK_SENT_ATTEMPTS) {
          this.log.error({ err, outboxId: row.id, kind: row.kind }, 'email sent, but its outbox row could not be marked sent');
          return;
        }
        await sleep(MARK_SENT_RETRY_MS * attempt);
      }
    }
  }

  /** Puts failed mails back into the queue. */
  async retryFailed(now = new Date()): Promise<number> {
    const result = await this.db
      .updateTable('email_outbox')
      .set({ status: 'pending', attempts: 0, next_attempt_at: now.toISOString() })
      .where('status', '=', 'failed')
      .executeTakeFirst();
    const requeued = Number(result.numUpdatedRows ?? 0);
    if (requeued > 0 && this.worker?.has(DELIVERY_TASK)) void this.worker.runNow(DELIVERY_TASK);
    return requeued;
  }

  /** Deletes sent/failed mails older than the retention and expired unconfirmed subscriptions. */
  async purge(now = new Date()): Promise<{ mails: number; subscribers: number }> {
    const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS).toISOString();
    const mails = await this.db
      .deleteFrom('email_outbox')
      .where('status', 'in', ['sent', 'failed'])
      .where('created_at', '<', cutoff)
      .executeTakeFirst();
    const subscribers = await purgeUnconfirmed(this.db, now);
    return { mails: Number(mails.numDeletedRows ?? 0), subscribers };
  }

  /** Sends a test mail immediately (not queued). 409 without transport. */
  async sendTest(to: string): Promise<{ ok: boolean; message: string }> {
    if (!mailerConfigured(this.mailer)) throw conflict('No mail transport configured (MAIL_TRANSPORT=none)');
    const settings = await getSettings(this.db);
    const mail = testMail(
      { siteName: settings.siteName, baseUrl: this.config.PUBLIC_BASE_URL, accentColor: settings.accentColor },
      settings.defaultLocale,
    );
    try {
      await this.mailer.send({ to, ...mail, headers: BASE_HEADERS });
      return {
        ok: true,
        message: this.mailer.transport === 'log' ? 'Test email written to the server log' : 'Test email sent',
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async status(): Promise<NotificationStatus> {
    const settings = await getSettings(this.db);
    const count = (q: Promise<{ n: number | string | bigint } | undefined>) => q.then((r) => Number(r?.n ?? 0));
    const [confirmed, pending, queuePending, queueFailed, lastSent, lastError] = await Promise.all([
      count(
        this.db
          .selectFrom('subscribers')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('confirmed_at', 'is not', null)
          .executeTakeFirst(),
      ),
      count(
        this.db
          .selectFrom('subscribers')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('confirmed_at', 'is', null)
          .executeTakeFirst(),
      ),
      count(
        this.db
          .selectFrom('email_outbox')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('status', '=', 'pending')
          .executeTakeFirst(),
      ),
      count(
        this.db
          .selectFrom('email_outbox')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('status', '=', 'failed')
          .executeTakeFirst(),
      ),
      this.db
        .selectFrom('email_outbox')
        .select('sent_at')
        .where('status', '=', 'sent')
        .orderBy('sent_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom('email_outbox')
        .select(['last_error', 'last_attempt_at'])
        .where('last_error', 'is not', null)
        .orderBy('last_attempt_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    ]);
    return {
      transport: this.mailer.transport,
      configured: mailerConfigured(this.mailer),
      from: this.mailer.from,
      subscriptionsEnabled: settings.emailSubscriptionsEnabled,
      subscribers: { confirmed, pending },
      queue: { pending: queuePending, failed: queueFailed },
      lastSentAt: lastSent?.sent_at ?? null,
      lastError:
        lastError?.last_error && lastError.last_attempt_at
          ? { message: lastError.last_error, at: lastError.last_attempt_at }
          : null,
    };
  }
}

/**
 * Background tasks (only with WORKER_ENABLED): outbox delivery every 10 s,
 * maintenance reminders every minute, hourly cleanup. Called from src/index.ts.
 */
export function registerNotificationTasks(ctx: {
  worker: Worker;
  notifications: NotificationService;
  log: FastifyBaseLogger;
}): void {
  const { worker, notifications, log } = ctx;
  worker.schedule(DELIVERY_TASK, DELIVERY_INTERVAL_MS, async () => {
    // Drain in batches while there is due work, but yield between runs of the interval.
    for (let i = 0; i < 10; i++) {
      const r = await notifications.deliverDue();
      if (r.sent + r.retried + r.failed < DELIVERY_BATCH) break;
    }
  });
  worker.schedule('maintenance-reminders', 60_000, async () => {
    const n = await notifications.sendDueReminders();
    if (n > 0) log.info({ maintenances: n }, 'maintenance reminders queued');
  });
  worker.schedule('notification-cleanup', HOUR_MS, async () => {
    const r = await notifications.purge();
    if (r.mails + r.subscribers > 0) log.info(r, 'old mails and unconfirmed subscriptions removed');
  });
}

/** The channel event of a maintenance mail kind and the current status. */
export function maintenanceEventType(kind: MaintenanceMailKind, status: string): ChannelEventType {
  if (kind === 'scheduled') return 'maintenance.scheduled';
  if (kind === 'reminder') return 'maintenance.reminder';
  if (status === 'in_progress') return 'maintenance.started';
  if (status === 'completed') return 'maintenance.completed';
  if (status === 'cancelled') return 'maintenance.cancelled';
  return 'maintenance.updated';
}
