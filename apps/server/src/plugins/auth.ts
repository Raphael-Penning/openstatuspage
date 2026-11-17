/**
 * Authentication & authorization for the admin API.
 *
 * STUB in feat/core: the real implementation (sessions, API tokens, CSRF
 * check) lands with the admin API. The exported signatures are the contract
 * other modules (e.g. adapters/routes.ts) build on.
 */
import type { UserRole } from '@openstatuspage/shared';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** How the request was authenticated. */
  via: 'session' | 'token';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin; null for anonymous requests. */
    authUser: AuthUser | null;
  }
}

/** Decorates every request with `authUser`. */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest('authUser', null);
}

/** preHandler that requires an authenticated user with at least `role` (admin > editor). */
export function requireRole(_role: UserRole): preHandlerAsyncHookHandler {
  return async () => {
    throw unauthorized();
  };
}
