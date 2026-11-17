/**
 * Login sessions and API tokens.
 *
 * Session token: 32 random bytes, only kept in the `osp_session` cookie.
 * The database stores its SHA-256 (`sessions.id`). Sessions use a sliding
 * expiry of SESSION_TTL_HOURS, capped by an absolute lifetime of
 * SESSION_MAX_AGE_HOURS from the login; expired rows are removed lazily and
 * by a periodic cleanup task.
 */
import type { UserRole } from '@openstatuspage/shared';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import type { User } from '../db/types.js';
import { sha256 } from '../lib/crypto.js';
import { newToken } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';

export const SESSION_COOKIE = 'osp_session';
/** Prefix of API tokens, makes leaked tokens easy to recognise for secret scanners. */
export const API_TOKEN_PREFIX = 'osp_';

const HOUR_MS = 3600_000;
/** API token `last_used_at` is written at most once per minute per token. */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;

export function sessionTtlMs(ctx: AppContext): number {
  return ctx.config.SESSION_TTL_HOURS * HOUR_MS;
}

/**
 * Absolute end of a session created at `createdAtMs`. Without it a session that
 * is used regularly would never expire, so a user removed from the IdP (whose
 * role is only re-checked on login) could keep working indefinitely.
 */
function sessionMaxEndMs(ctx: AppContext, createdAtMs: number): number {
  return createdAtMs + ctx.config.SESSION_MAX_AGE_HOURS * HOUR_MS;
}

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export async function createSession(
  ctx: AppContext,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(
    Math.min(now.getTime() + sessionTtlMs(ctx), sessionMaxEndMs(ctx, now.getTime())),
  ).toISOString();
  await ctx.db
    .insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: userId,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
    })
    .execute();
  await ctx.db.updateTable('users').set({ last_login_at: now.toISOString() }).where('id', '=', userId).execute();
  return { token, expiresAt };
}

export interface ResolvedSession {
  user: User;
  expiresAt: string;
  /** True when the expiry was extended and the cookie should be re-sent. */
  refreshed: boolean;
}

/**
 * Looks up a session token; extends its expiry (sliding, up to the absolute
 * lifetime) and deletes it when expired.
 */
export async function resolveSession(ctx: AppContext, token: string): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const id = sha256(token);
  const row = await ctx.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select(['sessions.expires_at as session_expires_at', 'sessions.created_at as session_created_at'])
    .where('sessions.id', '=', id)
    .executeTakeFirst();
  if (!row) return null;

  const { session_expires_at, session_created_at, ...user } = row;
  const now = Date.now();
  const expires = new Date(session_expires_at).getTime();
  // Checked on its own (not only via expires_at): sessions created before the cap
  // existed, or before SESSION_MAX_AGE_HOURS was lowered, may expire later.
  const maxEnd = sessionMaxEndMs(ctx, new Date(session_created_at).getTime());
  if (!(expires > now) || !(maxEnd > now)) {
    await ctx.db.deleteFrom('sessions').where('id', '=', id).execute();
    return null;
  }

  const ttl = sessionTtlMs(ctx);
  const target = Math.min(now + ttl, maxEnd);
  // Extend when a noticeable part of the lifetime has passed, to avoid a write per request.
  if (target - expires > Math.min(ttl * 0.1, HOUR_MS)) {
    const expiresAt = new Date(target).toISOString();
    await ctx.db.updateTable('sessions').set({ expires_at: expiresAt }).where('id', '=', id).execute();
    return { user, expiresAt, refreshed: true };
  }
  return { user, expiresAt: session_expires_at, refreshed: false };
}

export async function deleteSession(db: DB, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', sha256(token)).execute();
}

/** Deletes all sessions of a user, optionally keeping the one identified by `exceptToken`. */
export async function deleteUserSessions(db: DB, userId: string, exceptToken?: string | null): Promise<void> {
  let q = db.deleteFrom('sessions').where('user_id', '=', userId);
  if (exceptToken) q = q.where('id', '!=', sha256(exceptToken));
  await q.execute();
}

export async function cleanupExpiredSessions(db: DB, now = nowIso()): Promise<number> {
  const result = await db.deleteFrom('sessions').where('expires_at', '<=', now).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

/** Registers the periodic cleanup of expired sessions (hourly). Called from src/index.ts. */
export function registerSessionCleanup(ctx: AppContext): void {
  ctx.worker.schedule('session-cleanup', HOUR_MS, async () => {
    const removed = await cleanupExpiredSessions(ctx.db);
    if (removed > 0) ctx.log.debug({ removed }, 'expired sessions removed');
  });
}

export interface ResolvedApiToken {
  id: string;
  name: string;
  role: UserRole;
  /** User who created the token; null for tokens whose creator is unknown. */
  createdBy: string | null;
}

export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${newToken()}`;
}

export async function resolveApiToken(db: DB, token: string): Promise<ResolvedApiToken | null> {
  if (!token || token.length > 200) return null;
  const row = await db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'role', 'created_by', 'last_used_at'])
    .where('token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - new Date(row.last_used_at).getTime() > TOKEN_TOUCH_INTERVAL_MS) {
    await db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date(now).toISOString() })
      .where('id', '=', row.id)
      .execute();
  }
  return { id: row.id, name: row.name, role: row.role, createdBy: row.created_by };
}
