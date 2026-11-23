/**
 * /api/admin/themes (admin, JSON:API): the themes of the public pages (docs/themes.md).
 *
 *   GET    /api/admin/themes                  every theme: built-in, folder (THEMES_DIR), database
 *   POST   /api/admin/themes                  import a theme file (`definition`) and its extra `css`
 *   GET    /api/admin/themes/:id              one theme, with its extra CSS
 *   PATCH  /api/admin/themes/:id              database themes only: new `definition` and/or `css`
 *   DELETE /api/admin/themes/:id              database themes only; not the active one (409)
 *   POST   /api/admin/themes/:id/activate     make it the theme of the public pages
 *   GET    /api/admin/themes/:id/export       the theme file (application/json, download)
 *   GET    /api/admin/themes/:id/export-css   its extra CSS (text/css, download; 404 without)
 *
 * A theme that fails WCAG 2.2 AA (with the accent override of the settings)
 * is only activated, or changed while active, with `acceptContrastFailures:
 * true`; otherwise 409 `contrast_failures` with the failed checks in `meta`.
 * Extra CSS is checked with checkExtraCss and rejected as a whole (400).
 * Built-in and folder themes are read-only (409).
 */
import {
  checkExtraCss,
  themeContrastFailures,
  ThemeActivateInput,
  ThemeImportInput,
  ThemeUpdateInput,
  zThemeId,
  type AdminTheme,
  type ContrastCheck,
  type ThemeFile,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { collection, created, document, noContent, resource, selfLink } from '../../lib/jsonapi.js';
import { nowIso } from '../../lib/time.js';
import { actorUserId } from '../../plugins/auth.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { getSettings } from '../../services/settings.js';
import { themeFileIssues, type ThemeEntry } from '../../services/themes.js';
import { admin, auditRequest } from './util.js';

export const THEME_TYPE = 'themes';
/** Most themes stored in the database. */
export const MAX_STORED_THEMES = 50;

const ThemeParams = z.object({ id: zThemeId });

export function themeResource(theme: AdminTheme) {
  return resource(THEME_TYPE, theme.id, theme, { links: { self: `/api/admin/themes/${theme.id}` } });
}

/** The theme as the API answers it. */
export function adminTheme(
  entry: ThemeEntry,
  options: { activeId: string; accentOverride: string | null; withCss?: boolean },
): AdminTheme {
  return {
    id: entry.id,
    name: entry.theme.name,
    author: entry.theme.author ?? null,
    description: entry.theme.description ?? null,
    source: entry.source,
    readOnly: entry.source !== 'database',
    active: entry.id === options.activeId,
    definition: entry.theme,
    ...(options.withCss ? { css: entry.css } : {}),
    cssBytes: entry.css ? Buffer.byteLength(entry.css) : 0,
    contrastFailures: themeContrastFailures(entry.theme, options.accentOverride),
    updatedAt: entry.updatedAt,
  };
}

/** The theme file, or 400 with the problems (paths below `definition`). */
function parseDefinition(value: unknown): ThemeFile {
  const result = themeFileIssues(value);
  if ('issues' in result) {
    throw badRequest(
      'The theme file is not valid',
      result.issues.map((i) => ({ code: 'invalid_theme', path: ['definition', ...i.path], message: i.message })),
    );
  }
  return result.theme;
}

/** Extra CSS as stored (null for none), or 400 with the problems. */
function parseCss(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const issues = checkExtraCss(value);
  if (issues.length > 0) {
    throw badRequest(
      'The extra CSS is not allowed',
      issues.map((i) => ({ code: `css_${i.code}`, path: ['css'], message: i.excerpt ? `${i.message}: ${i.excerpt}` : i.message })),
    );
  }
  return value;
}

function contrastConflict(failures: ContrastCheck[]): HttpError {
  return new HttpError(
    409,
    'contrast_failures',
    `The theme fails WCAG 2.2 AA in ${failures.length} checks; confirm with acceptContrastFailures to use it anyway`,
    undefined,
    { meta: { failures } },
  );
}

/** Audit details: what the theme is, never its CSS. */
const auditDetails = (entry: Pick<ThemeEntry, 'theme' | 'css'>) => ({
  name: entry.theme.name,
  cssBytes: entry.css ? Buffer.byteLength(entry.css) : 0,
});

export async function registerThemeAdminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    registerRoutes(scope);
  });
  // Downloads: plain files, not JSON:API.
  await app.register(async (scope) => {
    registerExports(scope);
  });
}

function registerRoutes(app: FastifyInstance): void {
  const { db, themes } = app.ctx;
  const typed = { ...admin, config: { jsonapi: { type: THEME_TYPE } } };
  const idOf = (req: FastifyRequest) => parse(ThemeParams, req.params).id;

  const context = async () => {
    const [{ themeId }, settings] = await Promise.all([themes.selection(), getSettings(db)]);
    return { activeId: themeId, accentOverride: settings.accentColor ?? null };
  };
  const get = async (id: string): Promise<ThemeEntry> => {
    const entry = await themes.find(id);
    if (!entry) throw notFound('Theme');
    return entry;
  };
  const answer = async (req: FastifyRequest, entry: ThemeEntry) =>
    document(themeResource(adminTheme(entry, { ...(await context()), withCss: true })), { links: { self: selfLink(req) } });

  app.get('/api/admin/themes', admin, async (req) => {
    const [list, ctx] = await Promise.all([themes.list(), context()]);
    return collection(req, list.map((entry) => themeResource(adminTheme(entry, ctx))));
  });

  app.get('/api/admin/themes/:id', admin, async (req) => answer(req, await get(idOf(req))));

  app.post('/api/admin/themes', typed, async (req, reply) => {
    const input = parse(ThemeImportInput, req.body);
    const theme = parseDefinition(input.definition);
    const css = parseCss(input.css);
    if (await themes.find(theme.id)) throw conflict(`A theme with the id "${theme.id}" exists already`);
    const count = await db.selectFrom('themes').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_STORED_THEMES) throw conflict(`At most ${MAX_STORED_THEMES} uploaded themes`);
    const now = nowIso();
    await db
      .insertInto('themes')
      .values({
        id: theme.id,
        name: theme.name,
        definition: JSON.stringify(theme),
        css,
        created_by: actorUserId(req),
        created_at: now,
        updated_at: now,
      })
      .execute();
    const entry = await get(theme.id);
    await auditRequest(db, req, 'theme.create', 'theme', theme.id, auditDetails(entry));
    return created(reply, await answer(req, entry), `/api/admin/themes/${theme.id}`);
  });

  app.patch('/api/admin/themes/:id', typed, async (req) => {
    const id = idOf(req);
    const current = await get(id);
    if (current.source !== 'database') throw conflict('Built-in and folder themes cannot be changed here; import a copy with another id');
    const input = parse(ThemeUpdateInput, req.body);
    const theme = input.definition === undefined ? current.theme : parseDefinition(input.definition);
    if (theme.id !== id) {
      throw badRequest('The id of a theme cannot change', [{ code: 'invalid_theme', path: ['definition', 'id'], message: 'must stay the same' }]);
    }
    const css = input.css === undefined ? current.css : parseCss(input.css);
    const ctx = await context();
    const active = ctx.activeId === id;
    const failures = themeContrastFailures(theme, ctx.accentOverride);
    if (active && failures.length > 0 && !input.acceptContrastFailures) throw contrastConflict(failures);
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('themes').set({ name: theme.name, definition: JSON.stringify(theme), css, updated_at: now }).where('id', '=', id).execute();
      if (active) {
        await trx
          .updateTable('active_theme')
          .set({ contrast_accepted: failures.length > 0 ? 1 : 0, updated_at: now })
          .where('slot', '=', 'active')
          .execute();
      }
    });
    themes.invalidate();
    const entry = await get(id);
    await auditRequest(db, req, 'theme.update', 'theme', id, {
      ...auditDetails(entry),
      ...(active ? { active: true, contrastFailures: failures.length } : {}),
    });
    return answer(req, entry);
  });

  app.delete('/api/admin/themes/:id', admin, async (req, reply) => {
    const id = idOf(req);
    const entry = await get(id);
    if (entry.source !== 'database') throw conflict('Built-in and folder themes cannot be deleted here');
    if ((await themes.selection()).themeId === id) throw conflict('The active theme cannot be deleted; activate another theme first');
    await db.deleteFrom('themes').where('id', '=', id).execute();
    await auditRequest(db, req, 'theme.delete', 'theme', id, auditDetails(entry));
    return noContent(reply);
  });

  app.post(
    '/api/admin/themes/:id/activate',
    { ...admin, config: { jsonapi: { type: THEME_TYPE, allowId: true } } },
    async (req) => {
      const id = idOf(req);
      const entry = await get(id);
      const input = parse(ThemeActivateInput, req.body);
      const { accentOverride } = await context();
      const failures = themeContrastFailures(entry.theme, accentOverride);
      if (failures.length > 0 && !input.acceptContrastFailures) throw contrastConflict(failures);
      const previous = await themes.selection();
      await db
        .updateTable('active_theme')
        .set({ theme_id: id, contrast_accepted: failures.length > 0 ? 1 : 0, updated_at: nowIso() })
        .where('slot', '=', 'active')
        .execute();
      themes.invalidate();
      await auditRequest(db, req, 'theme.activate', 'theme', id, {
        name: entry.theme.name,
        source: entry.source,
        previous: previous.themeId,
        ...(failures.length > 0 ? { contrastFailuresAccepted: failures.length } : {}),
      });
      return answer(req, entry);
    },
  );
}

function registerExports(app: FastifyInstance): void {
  const { themes } = app.ctx;
  const idOf = (req: FastifyRequest) => parse(ThemeParams, req.params).id;

  app.get('/api/admin/themes/:id/export', admin, async (req, reply) => {
    const entry = await themes.find(idOf(req));
    if (!entry) throw notFound('Theme');
    return reply
      .type('application/json; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${entry.id}.json"`)
      .send(`${JSON.stringify(entry.theme, null, 2)}\n`);
  });

  app.get('/api/admin/themes/:id/export-css', admin, async (req, reply) => {
    const entry = await themes.find(idOf(req));
    if (!entry?.css) throw notFound('Extra CSS');
    return reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${entry.id}.css"`)
      .send(entry.css);
  });
}
