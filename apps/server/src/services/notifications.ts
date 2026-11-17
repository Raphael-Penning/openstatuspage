/**
 * Subscriber notifications and the mail outbox.
 *
 * Fan-out: incident/maintenance events create one outbox row per recipient
 * (after the request's DB transaction). Only PUBLIC incidents and maintenance
 * notify, and mails only name PUBLIC services. Recipients are confirmed
 * subscribers with "all services" plus those subscribed to at least one
 * affected public service.
 *
 * Delivery: a worker task sends due rows in batches and retries failures with
 * backoff (1 min, 5 min, 15 min, 1 h); after MAX_ATTEMPTS a row is marked failed.
 * Sent and failed rows are purged after OUTBOX_RETENTION_MS. Mails of a deleted
 * subscriber are dropped by the foreign key cascade.
 */
import type { NotificationStatus } from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { OutboxRow } from '../db/types.js';
import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { mailerConfigured, type Mailer } from '../mail/mailer.js';
import {
  incidentMail,
  maintenanceMail,
  testMail,
  type MailSite,
  type MaintenanceMailKind,
  type RenderedMail,
} from '../mail/templates.js';
import type { Worker } from '../worker.js';
import { loadIncident } from './incidents.js';
import { loadMaintenance } from './maintenances.js';
import { getSettings } from './settings.js';
import { purgeUnconfirmed, subscriberLinks, unsubscribeHeaders } from './subscriptions.js';

export const DELIVERY_TASK = 'email-delivery';
export const DELIVERY_INTERVAL_MS = 10_000;
export const DELIVERY_BATCH = 50;
export const MAX_ATTEMPTS = 5;
/** Wait before attempt n+1 after n failed attempts (index n-1). */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const OUTBOX_RETENTION_MS = 30 * 86400_000;
/** A row being sent is hidden from other runs for this long (crash safety). */
const CLAIM_MS = 10 * 60_000;
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
  token_salt: string;
}

export interface DeliveryResult {
  sent: number;
  retried: number;
  failed: number;
}

const BASE_HEADERS = { 'Auto-Submitted': 'auto-generated' };

export class NotificationService {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly mailer: Mailer,
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

  /** Inserts mails into the outbox and triggers delivery. */
  async enqueue(mails: OutboxMail[], now = new Date()): Promise<void> {
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

  /** Site data for templates, or null when notifications are off (setting or no transport). */
  private async site(): Promise<{ site: MailSite; reminderHours: number } | null> {
    if (!mailerConfigured(this.mailer)) return null;
    const settings = await getSettings(this.db);
    if (!settings.emailSubscriptionsEnabled) return null;
    return {
      site: { siteName: settings.siteName, baseUrl: this.config.BASE_URL, accentColor: settings.accentColor },
      reminderHours: settings.maintenanceReminderHours,
    };
  }

  /** Confirmed subscribers for an event affecting `publicServiceIds`. */
  async recipients(publicServiceIds: string[]): Promise<Recipient[]> {
    return this.db
      .selectFrom('subscribers')
      .select(['id', 'email', 'locale', 'token_salt'])
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
    render: (r: Recipient, links: { manageUrl: string; unsubscribeUrl: string }) => RenderedMail,
  ): Promise<number> {
    const recipients = await this.recipients(publicServiceIds);
    const mails = recipients.map((r): OutboxMail => {
      const links = subscriberLinks(this.config, r);
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
    const ctx = await this.site();
    if (!ctx) return 0;
    const rec = await loadIncident(this.db, incidentId);
    if (!rec || rec.row.is_public !== 1) return 0;
    const latest = rec.updates[0];
    const services = rec.services.filter((s) => s.isPublic);
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
    const ctx = await this.site();
    if (!ctx) return 0;
    const rec = await loadMaintenance(this.db, maintenanceId);
    if (!rec || rec.row.is_public !== 1) return 0;
    if (opts.requireStoredFlag && rec.row.notify_subscribers !== 1) return 0;
    // Newest update matching the current status (automatic start+complete share one timestamp).
    const latest = rec.updates.find((u) => u.status === rec.row.status) ?? rec.updates[0];
    const services = rec.services.filter((s) => s.isPublic);
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
    const ctx = await this.site();
    if (!ctx || ctx.reminderHours <= 0) return 0;
    const periodMs = ctx.reminderHours * HOUR_MS;
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

  /** Sends due outbox rows. Does nothing without a transport (rows stay pending). */
  async deliverDue(now = new Date(), limit = DELIVERY_BATCH): Promise<DeliveryResult> {
    const result: DeliveryResult = { sent: 0, retried: 0, failed: 0 };
    if (!mailerConfigured(this.mailer)) return result;
    const nowIso = now.toISOString();
    const rows = await this.db
      .selectFrom('email_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', nowIso)
      .orderBy('next_attempt_at')
      .orderBy('created_at')
      .limit(limit)
      .execute();

    for (const row of rows) {
      const claimed = await this.db
        .updateTable('email_outbox')
        .set({ next_attempt_at: new Date(now.getTime() + CLAIM_MS).toISOString() })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('next_attempt_at', '=', row.next_attempt_at)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) continue;
      await this.deliverOne(row, now, result);
    }
    if (result.sent + result.retried + result.failed > 0) this.log.debug({ ...result }, 'email outbox processed');
    return result;
  }

  private async deliverOne(row: OutboxRow, now: Date, result: DeliveryResult): Promise<void> {
    const nowIso = now.toISOString();
    const attempts = row.attempts + 1;
    try {
      await this.mailer.send({
        to: row.recipient,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body,
        headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : undefined,
      });
      await this.db
        .updateTable('email_outbox')
        .set({ status: 'sent', attempts, sent_at: nowIso, last_attempt_at: nowIso, last_error: null })
        .where('id', '=', row.id)
        .execute();
      result.sent++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const failed = attempts >= MAX_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;
      await this.db
        .updateTable('email_outbox')
        .set({
          status: failed ? 'failed' : 'pending',
          attempts,
          last_error: message,
          last_attempt_at: nowIso,
          next_attempt_at: failed ? nowIso : new Date(now.getTime() + backoff).toISOString(),
        })
        .where('id', '=', row.id)
        .execute();
      // No recipient address in the log.
      this.log.warn({ outboxId: row.id, kind: row.kind, attempts, failed, error: message }, 'email delivery failed');
      if (failed) result.failed++;
      else result.retried++;
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
      { siteName: settings.siteName, baseUrl: this.config.BASE_URL, accentColor: settings.accentColor },
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
