/**
 * Login sessions and API tokens.
 *
 * Session token: 32 random bytes, only kept in the `osp_session` cookie.
 * The database stores its SHA-256 (`sessions.id`). Sessions use a sliding
 * expiry of SESSION_TTL_HOURS; expired rows are removed lazily and by a
 * periodic cleanup task.
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
  const expiresAt = new Date(now.getTime() + sessionTtlMs(ctx)).toISOString();
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

/** Looks up a session token; extends its expiry (sliding) and deletes it when expired. */
export async function resolveSession(ctx: AppContext, token: string): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const id = sha256(token);
  const row = await ctx.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select(['sessions.expires_at as session_expires_at'])
    .where('sessions.id', '=', id)
    .executeTakeFirst();
  if (!row) return null;

  const now = Date.now();
  const expires = new Date(row.session_expires_at).getTime();
  if (!(expires > now)) {
    await ctx.db.deleteFrom('sessions').where('id', '=', id).execute();
    return null;
  }

  const { session_expires_at, ...user } = row;
  const ttl = sessionTtlMs(ctx);
  // Extend when a noticeable part of the lifetime has passed, to avoid a write per request.
  if (ttl - (expires - now) > Math.min(ttl * 0.1, HOUR_MS)) {
    const expiresAt = new Date(now + ttl).toISOString();
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
}

export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${newToken()}`;
}

export async function resolveApiToken(db: DB, token: string): Promise<ResolvedApiToken | null> {
  if (!token || token.length > 200) return null;
  const row = await db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'role', 'last_used_at'])
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
  return { id: row.id, name: row.name, role: row.role };
}
