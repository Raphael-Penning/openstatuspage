/**
 * Mail transports. Selected by MAIL_TRANSPORT (see config.ts):
 *
 * - smtp: delivers via nodemailer. STARTTLS is used when the server offers it,
 *   SMTP_SECURE=true switches to implicit TLS (port 465).
 * - log:  writes every mail to the server log instead of sending it (development).
 * - none: no transport; sending fails. Subscriptions are not offered.
 *
 * Tests use MemoryMailer.
 */
import type { MailTransportKind } from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
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

/** Writes mails to the server log (development only: the log then contains confirmation links). */
export class LogMailer implements Mailer {
  readonly transport = 'log' as const;
  constructor(
    readonly from: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info(
      { mail: { from: this.from, to: message.to, subject: message.subject, headers: message.headers ?? {} } },
      `mail (MAIL_TRANSPORT=log)\n${message.text}`,
    );
  }
  close(): void {}
}

export class SmtpMailer implements Mailer {
  readonly transport = 'smtp' as const;
  private readonly transporter: nodemailer.Transporter;

  constructor(
    readonly from: string,
    options: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
      rejectUnauthorized: boolean;
    },
  ) {
    this.transporter = nodemailer.createTransport({
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
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    });
  }

  close(): void {
    this.transporter.close();
  }
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
      return new LogMailer(config.SMTP_FROM!, log);
    default:
      return new NoneMailer();
  }
}
