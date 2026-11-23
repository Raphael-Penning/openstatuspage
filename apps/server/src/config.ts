/**
 * Runtime configuration, read exclusively from environment variables.
 * See `.env.example` in the repository root for documentation of every option.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MailTransportKind } from '@openstatuspage/shared';
import { z } from 'zod';
import { APP_ROLES, type AppRole } from './role.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  /** Defaults to production; `pnpm dev` sets development. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  /**
   * What this instance does (see role.ts): `public` (status page, public API, feeds,
   * subscriptions), `admin` (management UI/API, login, ingest, plus the public API),
   * `worker` (background jobs, only /api/health) or `all` (everything, default).
   * Every role except `all` needs PostgreSQL.
   */
  APP_ROLE: z.enum(APP_ROLES).default('all'),
  /**
   * Seconds a `public` instance waits on start for the database schema to reach the
   * version it was built for (the admin or worker instance runs the migrations).
   */
  SCHEMA_WAIT_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Base URL of this instance, used for OIDC redirects, ingest URLs and secure cookies. */
  BASE_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Base URL of the public status page, used for every link in mails and feeds.
   * Defaults to BASE_URL. Set it on admin and worker instances of a split deployment,
   * whose BASE_URL is the admin domain.
   */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** `sqlite:<path>` or `postgres://user:pass@host:5432/db`. */
  DATABASE_URL: z.string().default('sqlite:./data/openstatuspage.db'),
  /**
   * PostgreSQL only: the restricted database role (login) of APP_ROLE=public instances.
   * Instances that migrate grant it access to the osp_public schema on every start,
   * once the role exists (deploy/postgres/roles.sql, docs/security-model.md).
   */
  DB_PUBLIC_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'expected a lower-case PostgreSQL role name')
    .default('osp_public'),
  /**
   * Secret used to encrypt monitoring credentials at rest and to sign cookies.
   * At least 32 characters. Changing it makes stored credentials unreadable.
   */
  SECRET_KEY: z.string().min(32).optional(),
  /**
   * Key of the email subscription tokens (confirm and manage links). Defaults to
   * SECRET_KEY. A split deployment sets its own value on every instance and gives
   * the public instance only this key, not SECRET_KEY.
   */
  SUBSCRIPTION_TOKEN_KEY: z.string().min(32).optional(),
  /**
   * APP_ROLE=public on PostgreSQL refuses to start when its database login is not a
   * registered public role (DB_PUBLIC_ROLE). `true` only logs a warning instead.
   */
  ALLOW_UNRESTRICTED_PUBLIC_DB: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Reverse proxy trust, so client IPs and https are detected from X-Forwarded-* headers.
   * `false` (default), `true` (= 1 hop), a hop count, or a comma separated list of
   * trusted proxy addresses/CIDRs. Never trust every hop: clients could spoof their IP.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, ctx): false | number | string[] => {
      const value = v.trim().toLowerCase();
      if (['false', '0', 'no', ''].includes(value)) return false;
      if (['true', 'yes'].includes(value)) return 1;
      if (/^\d+$/.test(value)) return Number(value);
      const list = value.split(',').map((x) => x.trim()).filter(Boolean);
      if (list.every((x) => /^[0-9a-f.:]+(\/\d{1,3})?$/.test(x))) return list;
      ctx.addIssue({ code: 'custom', message: 'expected true/false, a hop count or a list of IPs/CIDRs' });
      return z.NEVER;
    }),
  /** Session lifetime in hours. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  /**
   * Absolute session lifetime in hours, counted from the login. The sliding
   * expiry never extends a session past it. Defaults to 30 days (or
   * SESSION_TTL_HOURS when that is longer).
   */
  SESSION_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(24 * 365).optional(),

  /** Creates this admin on first start when no user exists. */
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),

  /** Disable username/password login (OIDC only). */
  LOCAL_LOGIN_ENABLED: bool.default(true),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  /** Button label on the login page. */
  OIDC_LABEL: z.string().default('Single Sign-On'),
  /** Claim holding group/role membership, e.g. `groups` or `roles`. */
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  /** Group granting the admin role. */
  OIDC_ADMIN_GROUP: z.string().optional(),
  /** Group granting the editor role. Without it, every account of the IdP may log in as editor. */
  OIDC_EDITOR_GROUP: z.string().optional(),
  /** Create users on first OIDC login. Off by default: only pre-created users may log in. */
  OIDC_AUTO_CREATE_USERS: bool.default(false),

  /** Directory with the built web client. Defaults to ../web/dist relative to the server. */
  WEB_DIST_DIR: z.string().optional(),
  /**
   * Folder with theme files (`<id>.json`, optional `<id>.css`; docs/themes.md), read
   * on start. Default: `themes` next to the SQLite database, `./themes` with PostgreSQL.
   * A missing folder is no error.
   */
  THEMES_DIR: z.string().max(4096).optional(),
  /**
   * Run the background tasks (pollers, scheduler, mail delivery, cleanup). Defaults to
   * true for APP_ROLE=all and worker, false for admin; never allowed for public.
   */
  WORKER_ENABLED: bool.optional(),
  /**
   * Check bundles: how long a result of a push-only source (type webhook) counts
   * in a bundle vote before the member is treated as not reporting. Pull sources
   * use 3 poll intervals (at least 5 minutes) instead.
   */
  BUNDLE_PUSH_STALE_SECONDS: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
  /**
   * Most checks one monitoring source may have. Pushes and polls that would exceed
   * it are rejected and store nothing.
   */
  MAX_CHECKS_PER_SOURCE: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
  /**
   * Pull adapters: most MiB of one (decompressed) response body. Sized against the
   * image's heap cap (NODE_OPTIONS --max-old-space-size=96); raise both together.
   */
  POLL_MAX_RESPONSE_MB: z.coerce.number().min(1).max(512).default(8),
  /**
   * Pull adapters: most values one response body may hold (JSON objects, arrays and
   * elements; lines of text), checked before parsing. Raise together with the heap cap.
   */
  POLL_MAX_VALUES: z.coerce.number().int().min(1000).max(100_000_000).default(500_000),

  /**
   * How notification mails are delivered: `smtp`, `log` (written to the server log,
   * for development) or `none`. Defaults to `smtp` when SMTP_HOST is set, else `none`.
   */
  MAIL_TRANSPORT: z.enum(['smtp', 'log', 'none']).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** `true` = implicit TLS (e.g. port 465). Otherwise STARTTLS is used when the server offers it. */
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Sender address, e.g. `Example Status <status@example.com>`. Required for smtp/log. */
  SMTP_FROM: z.string().max(320).optional(),
  /** Verify the SMTP server certificate. Only disable for testing with self-signed certificates. */
  SMTP_TLS_REJECT_UNAUTHORIZED: bool.default(true),
  /**
   * Directory with the DKIM public keys of the bundled mail server (`<domain>.<selector>.txt`,
   * read-only). The admin portal then shows the DNS records to publish (SPF, DKIM, DMARC).
   */
  MAIL_DKIM_DIR: z.string().max(4096).optional(),

  /**
   * Base URL of the Umami server (https://umami.is) for the analytics of the public
   * pages, e.g. `https://umami.example.com`. The instances that serve public pages
   * proxy its script and events under /pulse/ (docs/configuration.md#analytics).
   * Unset: no analytics, whatever the settings say. An instance setting on purpose:
   * the management UI only chooses the website ID, never where the server connects.
   */
  UMAMI_URL: z
    .url({ protocol: /^https?$/, error: 'expected an http(s) URL' })
    .refine((v) => !/[?#]/.test(v), 'expected a base URL without query or fragment')
    .optional(),
});

export type Config = Omit<
  z.infer<typeof EnvSchema>,
  'MAIL_TRANSPORT' | 'SESSION_MAX_AGE_HOURS' | 'WORKER_ENABLED' | 'PUBLIC_BASE_URL' | 'SUBSCRIPTION_TOKEN_KEY'
> & {
  /** Effective: PUBLIC_BASE_URL or BASE_URL, without trailing slash. */
  PUBLIC_BASE_URL: string;
  /** SECRET_KEY; on a public instance without one a random key of this process (nothing it does needs it). */
  SECRET_KEY: string;
  /** Effective: SUBSCRIPTION_TOKEN_KEY or SECRET_KEY. */
  SUBSCRIPTION_TOKEN_KEY: string;
  /** Effective: WORKER_ENABLED or the default of APP_ROLE. */
  WORKER_ENABLED: boolean;
  /** Effective absolute session lifetime (never shorter than SESSION_TTL_HOURS). */
  SESSION_MAX_AGE_HOURS: number;
  /** True when SECRET_KEY was not set and the public development secret is used. */
  insecureSecret: boolean;
  oidcEnabled: boolean;
  database: { dialect: 'sqlite'; filename: string } | { dialect: 'postgres'; connectionString: string };
  /** Effective mail transport (MAIL_TRANSPORT or derived from SMTP_HOST). */
  MAIL_TRANSPORT: MailTransportKind;
};

const DEV_SECRET = 'insecure-development-secret-change-me-please';
/**
 * Published example values (the development fallback, deploy/kubernetes/secret.example.yaml).
 * Anyone can read them, so production refuses them as SECRET_KEY or SUBSCRIPTION_TOKEN_KEY.
 */
const PLACEHOLDER_SECRETS = new Set([DEV_SECRET, 'change-me-to-a-long-random-value']);
const DEFAULT_SESSION_MAX_AGE_HOURS = 24 * 30;

export interface LoadConfigOptions {
  /**
   * Allow a missing SECRET_KEY outside development/test (falls back to the public
   * development secret). Only for CLI commands that never touch secrets.
   */
  allowMissingSecret?: boolean;
  /**
   * Allow APP_ROLE public/admin/worker on SQLite. Only for tests: SQLite is a
   * single-instance database and only supports APP_ROLE=all.
   */
  allowSqliteForAnyRole?: boolean;
}

/** Default of WORKER_ENABLED per role. */
const WORKER_DEFAULT: Record<AppRole, boolean> = { all: true, worker: true, admin: false, public: false };

/**
 * Loads a `.env` file into process.env (existing variables win). Looks at
 * ENV_FILE, then `.env` in the working directory and the repository root.
 */
export function loadEnvFile(): void {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  const file = candidates.find((f) => existsSync(f));
  if (file) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  if (env === process.env) loadEnvFile();
  // Treat empty values (e.g. `SECRET_KEY=` from .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const c = parsed.data;

  if (c.NODE_ENV === 'production' && !options.allowMissingSecret) {
    const placeholders = (['SECRET_KEY', 'SUBSCRIPTION_TOKEN_KEY'] as const).filter((name) => {
      const value = c[name];
      return value !== undefined && PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
    });
    if (placeholders.length > 0) {
      throw new Error(
        `Invalid configuration:\n${placeholders
          .map((name) => `  ${name}: is a published example value; set a random one (e.g. \`openssl rand -base64 48\`)`)
          .join('\n')}`,
      );
    }
  }

  let secret = c.SECRET_KEY;
  if (!secret && c.APP_ROLE === 'public' && c.SUBSCRIPTION_TOKEN_KEY) {
    // A public instance encrypts no credentials and signs no cookies: it only needs the token key.
    secret = randomBytes(48).toString('base64url');
  }
  if (!secret) {
    if (c.NODE_ENV === 'production' && !options.allowMissingSecret) {
      throw new Error(
        c.APP_ROLE === 'public'
          ? 'SUBSCRIPTION_TOKEN_KEY must be set for APP_ROLE=public (the same value as on the admin and worker ' +
              'instances, at least 32 characters). The public instance does not need SECRET_KEY.'
          : 'SECRET_KEY must be set (at least 32 characters, e.g. `openssl rand -base64 48`). ' +
              'For local development run `pnpm dev` or set NODE_ENV=development.',
      );
    }
    secret = DEV_SECRET;
  }

  let database: Config['database'];
  if (c.DATABASE_URL.startsWith('postgres://') || c.DATABASE_URL.startsWith('postgresql://')) {
    database = { dialect: 'postgres', connectionString: c.DATABASE_URL };
  } else if (c.DATABASE_URL.startsWith('sqlite:')) {
    database = { dialect: 'sqlite', filename: c.DATABASE_URL.slice('sqlite:'.length) || ':memory:' };
  } else {
    throw new Error('DATABASE_URL must start with sqlite: or postgres://');
  }

  const role = c.APP_ROLE;
  const roleIssues: string[] = [];
  if (role !== 'all' && database.dialect === 'sqlite' && !options.allowSqliteForAnyRole) {
    roleIssues.push(
      `  APP_ROLE: ${role} needs PostgreSQL. SQLite is a single-instance database and only supports APP_ROLE=all ` +
        '(one instance running everything).',
    );
  }
  if (role === 'public' && c.WORKER_ENABLED === true) {
    roleIssues.push('  WORKER_ENABLED: must not be true with APP_ROLE=public (the public instance runs no background tasks)');
  }
  if (role === 'worker' && c.WORKER_ENABLED === false) {
    roleIssues.push('  WORKER_ENABLED: must not be false with APP_ROLE=worker (the worker instance only runs background tasks)');
  }
  if (roleIssues.length > 0) throw new Error(`Invalid configuration:\n${roleIssues.join('\n')}`);
  const workerEnabled = c.WORKER_ENABLED ?? WORKER_DEFAULT[role];

  // Login and OIDC only exist where the admin routes are served.
  const oidcEnabled = (role === 'all' || role === 'admin') && Boolean(c.OIDC_ISSUER_URL && c.OIDC_CLIENT_ID);

  const mailTransport: MailTransportKind = c.MAIL_TRANSPORT ?? (c.SMTP_HOST ? 'smtp' : 'none');
  const mailIssues: string[] = [];
  if (mailTransport !== 'none' && !c.SMTP_FROM) mailIssues.push(`  SMTP_FROM: required when MAIL_TRANSPORT=${mailTransport}`);
  // A public instance only queues mails (the worker delivers them), so it needs no SMTP server.
  if (mailTransport === 'smtp' && !c.SMTP_HOST && role !== 'public') {
    mailIssues.push('  SMTP_HOST: required when MAIL_TRANSPORT=smtp');
  }
  if (c.SMTP_FROM && !/@[^\s@>]+\.[^\s@>]+>?\s*$/.test(c.SMTP_FROM)) {
    mailIssues.push('  SMTP_FROM: expected an address like "Example Status <status@example.com>"');
  }
  if (mailIssues.length > 0) throw new Error(`Invalid configuration:\n${mailIssues.join('\n')}`);

  // An explicit absolute lifetime shorter than the sliding one is contradictory. The
  // default follows a longer SESSION_TTL_HOURS, so existing setups keep working.
  if (c.SESSION_MAX_AGE_HOURS !== undefined && c.SESSION_MAX_AGE_HOURS < c.SESSION_TTL_HOURS) {
    throw new Error(
      `Invalid configuration:\n  SESSION_MAX_AGE_HOURS: must be at least SESSION_TTL_HOURS (${c.SESSION_TTL_HOURS})`,
    );
  }
  const sessionMaxAgeHours = c.SESSION_MAX_AGE_HOURS ?? Math.max(DEFAULT_SESSION_MAX_AGE_HOURS, c.SESSION_TTL_HOURS);

  return {
    ...c,
    WORKER_ENABLED: workerEnabled,
    BASE_URL: c.BASE_URL.replace(/\/+$/, ''),
    PUBLIC_BASE_URL: (c.PUBLIC_BASE_URL ?? c.BASE_URL).replace(/\/+$/, ''),
    SECRET_KEY: secret,
    SUBSCRIPTION_TOKEN_KEY: c.SUBSCRIPTION_TOKEN_KEY ?? secret,
    insecureSecret: secret === DEV_SECRET,
    oidcEnabled,
    database,
    MAIL_TRANSPORT: mailTransport,
    SESSION_MAX_AGE_HOURS: sessionMaxAgeHours,
    UMAMI_URL: c.UMAMI_URL?.replace(/\/+$/, ''),
  };
}

/**
 * Settings that are valid but probably not what the operator wants. Logged on
 * start (src/index.ts).
 */
export function configWarnings(config: Pick<Config, 'TRUST_PROXY' | 'APP_ROLE' | 'NODE_ENV' | 'BASE_URL'>): string[] {
  const warnings: string[] = [];
  const base = new URL(config.BASE_URL);
  if (
    config.NODE_ENV === 'production' &&
    (config.APP_ROLE === 'all' || config.APP_ROLE === 'admin') &&
    base.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  ) {
    warnings.push(
      `BASE_URL ${base.origin} is http: the session cookie is sent without the Secure flag, so a browser also ` +
        'sends it over plain HTTP. Behind a TLS proxy set BASE_URL to the https:// address.',
    );
  }
  if (typeof config.TRUST_PROXY === 'number' && config.APP_ROLE !== 'worker') {
    warnings.push(
      `TRUST_PROXY=${config.TRUST_PROXY} trusts the nearest ${config.TRUST_PROXY === 1 ? 'hop' : 'hops'} whatever ` +
        'the address: a client that reaches the app port directly (not through the proxy) can choose its IP with ' +
        'X-Forwarded-For and evade the per-client rate limits. Make the port reachable only through the proxy, or ' +
        'set TRUST_PROXY to the addresses of the proxies.',
    );
  }
  return warnings;
}
