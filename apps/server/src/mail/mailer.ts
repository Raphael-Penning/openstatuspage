/**
 * Mail transports. Selected by MAIL_TRANSPORT (see config.ts):
 *
 * - smtp: delivers via nodemailer. STARTTLS is used when the server offers it,
 *   SMTP_SECURE=true switches to implicit TLS (port 465). nodemailer is loaded
 *   with the first mail, so instances that never send do not keep it in memory.
 * - log:  writes every mail to the server log instead of sending it (development;
 *         with NODE_ENV=production the link tokens are redacted).
 * - none: no transport; sending fails. Subscriptions are not offered.
 *
 * With APP_ROLE=public the configured kind is kept (subscriptions are offered when
 * it is not `none`), but the instance never sends: mails go to the outbox and a
 * worker instance delivers them (OutboxOnlyMailer).
 *
 * Tests use MemoryMailer.
 */
import type { MailTransportKind } from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Transporter } from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Additional headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface Mailer {
  readonly transport: MailTransportKind;
  /** Sender address (SMTP_FROM), null without transport. */
  readonly from: string | null;
  /** Sends one message; throws on failure. */
  send(message: MailMessage): Promise<void>;
  close(): void;
}

/** A transport that can actually deliver (or log) mail is configured. */
export function mailerConfigured(mailer: Mailer): boolean {
  return mailer.transport !== 'none';
}

export class NoneMailer implements Mailer {
  readonly transport = 'none' as const;
  readonly from = null;
  async send(): Promise<void> {
    throw new Error('No mail transport configured (MAIL_TRANSPORT=none)');
  }
  close(): void {}
}

/** `token=<value>` in a link (query or fragment). */
const LINK_TOKEN = /([?&#;]token=)[^&#\s>"']+/gi;

/** Replaces the token values of the links in a text (confirm, manage and unsubscribe links). */
export function redactLinkTokens(text: string): string {
  return text.replace(LINK_TOKEN, '$1[redacted]');
}

/**
 * Writes mails to the server log (development: the log then contains confirmation and
 * manage links). With `redactTokens` (NODE_ENV=production) the token values of the
 * links are replaced, so the log holds no subscription credentials.
 */
export class LogMailer implements Mailer {
  readonly transport = 'log' as const;
  constructor(
    readonly from: string,
    private readonly log: FastifyBaseLogger,
    private readonly options: { redactTokens?: boolean } = {},
  ) {}

  async send(message: MailMessage): Promise<void> {
    const clean = this.options.redactTokens ? redactLinkTokens : (text: string) => text;
    const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([name, value]) => [name, clean(value)]));
    this.log.info(
      { mail: { from: this.from, to: message.to, subject: message.subject, headers } },
      `mail (MAIL_TRANSPORT=log)\n${clean(message.text)}`,
    );
  }
  close(): void {}
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  rejectUnauthorized: boolean;
}

export class SmtpMailer implements Mailer {
  readonly transport = 'smtp' as const;
  private transporter: Promise<Transporter> | null = null;

  constructor(
    readonly from: string,
    private readonly options: SmtpOptions,
  ) {}

  /** Loads nodemailer and opens the connection pool on first use. */
  private connect(): Promise<Transporter> {
    const { options } = this;
    this.transporter ??= import('nodemailer').then(({ default: nodemailer }) =>
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.user ? { user: options.user, pass: options.password ?? '' } : undefined,
        tls: { rejectUnauthorized: options.rejectUnauthorized },
        pool: true,
        maxConnections: 2,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    );
    return this.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    const transporter = await this.connect();
    await transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    });
  }

  close(): void {
    void this.transporter?.then((t) => t.close());
  }
}

/**
 * Mailer of a public instance: reports the configured transport so the instance
 * knows whether subscriptions are offered, but never opens a connection. Every
 * mail is queued in the outbox and delivered by a worker instance.
 */
export class OutboxOnlyMailer implements Mailer {
  constructor(
    readonly transport: MailTransportKind,
    readonly from: string | null,
  ) {}

  async send(): Promise<void> {
    throw new Error('This instance (APP_ROLE=public) does not send mail; a worker instance delivers the outbox');
  }
  close(): void {}
}

/** Collects mails in memory. For tests; `fail` makes the next sends throw. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** Number of upcoming send() calls that fail. */
  failNext = 0;

  constructor(
    readonly transport: MailTransportKind = 'smtp',
    readonly from: string | null = 'Example Status <status@example.com>',
  ) {}

  async send(message: MailMessage): Promise<void> {
    if (this.transport === 'none') throw new Error('No mail transport configured (MAIL_TRANSPORT=none)');
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('550 simulated delivery failure');
    }
    this.sent.push(message);
  }

  close(): void {}
}

export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  if (config.APP_ROLE === 'public') return new OutboxOnlyMailer(config.MAIL_TRANSPORT, config.SMTP_FROM ?? null);
  switch (config.MAIL_TRANSPORT) {
    case 'smtp':
      return new SmtpMailer(config.SMTP_FROM!, {
        host: config.SMTP_HOST!,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        user: config.SMTP_USER,
        password: config.SMTP_PASSWORD,
        rejectUnauthorized: config.SMTP_TLS_REJECT_UNAUTHORIZED,
      });
    case 'log':
      return new LogMailer(config.SMTP_FROM!, log, { redactTokens: config.NODE_ENV === 'production' });
    default:
      return new NoneMailer();
  }
}
