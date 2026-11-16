/**
 * Runtime configuration, read exclusively from environment variables.
 * See `.env.example` in the repository root for documentation of every option.
 */
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public base URL, used for links in feeds, OIDC redirects and ingest URLs. */
  BASE_URL: z.string().url().default('http://localhost:3000'),
  /** `sqlite:<path>` or `postgres://user:pass@host:5432/db`. */
  DATABASE_URL: z.string().default('sqlite:./data/openstatuspage.db'),
  /**
   * Secret used to encrypt monitoring credentials at rest and to sign cookies.
   * At least 32 characters. Changing it makes stored credentials unreadable.
   */
  SECRET_KEY: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Set when running behind a reverse proxy so client IPs and https are detected. */
  TRUST_PROXY: bool.default(false),
  /** Session lifetime in hours. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),

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
  /** Group granting the editor role. Without it, every authenticated user may log in as editor. */
  OIDC_EDITOR_GROUP: z.string().optional(),
  /** Create users on first OIDC login. */
  OIDC_AUTO_CREATE_USERS: bool.default(true),

  /** Directory with the built web client. Defaults to ../web/dist relative to the server. */
  WEB_DIST_DIR: z.string().optional(),
  /** Disable the background poller/scheduler (e.g. for additional read-only replicas). */
  WORKER_ENABLED: bool.default(true),
});

export type Config = z.infer<typeof EnvSchema> & {
  SECRET_KEY: string;
  oidcEnabled: boolean;
  database: { dialect: 'sqlite'; filename: string } | { dialect: 'postgres'; connectionString: string };
};

const DEV_SECRET = 'insecure-development-secret-change-me-please';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const c = parsed.data;

  let secret = c.SECRET_KEY;
  if (!secret) {
    if (c.NODE_ENV === 'production') {
      throw new Error('SECRET_KEY must be set in production (at least 32 characters).');
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

  const oidcEnabled = Boolean(c.OIDC_ISSUER_URL && c.OIDC_CLIENT_ID);

  return {
    ...c,
    BASE_URL: c.BASE_URL.replace(/\/+$/, ''),
    SECRET_KEY: secret,
    oidcEnabled,
    database,
  };
}
