/**
 * Content of the public page (admin, JSON:API):
 *
 *   GET    /api/admin/pages                content pages (the four system pages and custom pages)
 *   POST   /api/admin/pages                a custom page
 *   GET    /api/admin/pages/:id
 *   PATCH  /api/admin/pages/:id            partial update (system pages keep slug and placement)
 *   DELETE /api/admin/pages/:id            custom pages only
 *
 *   GET    /api/admin/uploads              uploaded images
 *   POST   /api/admin/uploads              the image bytes as `application/octet-stream`
 *                                          (?fileName= for display), at most 1 MiB;
 *                                          PNG, JPEG, WebP or ICO by their magic bytes
 *   DELETE /api/admin/uploads/:id
 *
 *   GET    /api/admin/instance             facts of this instance for the management UI (the version)
 *
 * Pages and uploads are edited by admins (like the settings); the instance
 * facts are shown to every signed-in user, never to anonymous clients.
 */
import { SitePageInput, UPLOAD_MAX_BYTES, type AdminSitePage } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { conflict, HttpError, isUniqueViolation, notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';
import { newId } from '../../lib/ids.js';
import { collection, created, document, noContent, resource, selfLink } from '../../lib/jsonapi.js';
import { nowIso } from '../../lib/time.js';
import { appVersion } from '../../lib/version.js';
import { owningUserId } from '../../plugins/auth.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { loadAdminSitePages } from '../../services/site-pages.js';
import { cleanFilename, loadAdminUploads, storeUpload } from '../../services/uploads.js';
import { admin, auditRequest, editor } from './util.js';

export const CONTENT_TYPES = { page: 'pages', upload: 'uploads', instance: 'instances' } as const;

const pageResource = (page: AdminSitePage) =>
  resource(CONTENT_TYPES.page, page.id, (({ id: _id, ...rest }) => rest)(page), { links: { self: `/api/admin/pages/${page.id}` } });

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

/** Columns of a page from the validated input. */
const pageColumns = (input: SitePageInput) => ({
  title_en: input.title.en,
  title_de: input.title.de,
  description_en: input.description.en,
  description_de: input.description.de,
  body_en: input.body.en,
  body_de: input.body.de,
  published: input.published ? 1 : 0,
});

export async function registerContentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    registerPageRoutes(scope);
    registerUploadAdminRoutes(scope);
    scope.get('/api/admin/instance', editor, async (req) =>
      document(resource(CONTENT_TYPES.instance, 'current', { version: appVersion() }), { links: { self: selfLink(req) } }),
    );
  });
}

function registerPageRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;
  const typed = { ...admin, config: { jsonapi: { type: CONTENT_TYPES.page } } };

  const get = async (id: string): Promise<AdminSitePage> => {
    const [page] = await loadAdminSitePages(db, [id]);
    if (!page) throw notFound('Page');
    return page;
  };

  app.get('/api/admin/pages', admin, async (req) => collection(req, (await loadAdminSitePages(db)).map(pageResource)));

  app.get('/api/admin/pages/:id', admin, async (req) =>
    document(pageResource(await get(parse(IdParams, req.params).id)), { links: { self: selfLink(req) } }),
  );

  app.post('/api/admin/pages', typed, async (req, reply) => {
    const input = parse(SitePageInput, req.body);
    const id = newId();
    const now = nowIso();
    try {
      await db
        .insertInto('site_pages')
        .values({
          id,
          system_key: null,
          slug: input.slug,
          ...pageColumns(input),
          show_in_footer: input.showInFooter ? 1 : 0,
          show_in_nav: input.showInNav ? 1 : 0,
          sort_order: input.sortOrder,
          created_by: owningUserId(req),
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (err) {
      // The slugs of the system pages are taken as well (one namespace for /api/public/pages/{slug}).
      if (isUniqueViolation(err)) throw conflict(`A page with the slug "${input.slug}" exists already`);
      throw err;
    }
    await auditRequest(db, req, 'page.create', 'page', id, { slug: input.slug });
    return created(reply, document(pageResource(await get(id)), { links: { self: selfLink(req) } }), `/api/admin/pages/${id}`);
  });

  app.patch('/api/admin/pages/:id', typed, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await get(id);
    const input = parse(SitePageInput, {
      slug: current.slug,
      title: current.title,
      description: current.description,
      body: current.body,
      published: current.published,
      showInFooter: current.showInFooter,
      showInNav: current.showInNav,
      sortOrder: current.sortOrder,
      ...asObject(req.body),
    });
    const system = current.systemKey !== null;
    try {
      await db
        .updateTable('site_pages')
        .set({
          ...pageColumns(input),
          // A system page keeps its slug (its path) and its place on the page.
          ...(system
            ? {}
            : {
                slug: input.slug,
                show_in_footer: input.showInFooter ? 1 : 0,
                show_in_nav: input.showInNav ? 1 : 0,
                sort_order: input.sortOrder,
              }),
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A page with the slug "${input.slug}" exists already`);
      throw err;
    }
    await auditRequest(db, req, 'page.update', 'page', id, { slug: system ? current.slug : input.slug, published: input.published });
    return document(pageResource(await get(id)), { links: { self: selfLink(req) } });
  });

  app.delete('/api/admin/pages/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const page = await get(id);
    if (page.systemKey) throw conflict('System pages cannot be deleted; unpublish them instead');
    await db.deleteFrom('site_pages').where('id', '=', id).execute();
    await auditRequest(db, req, 'page.delete', 'page', id, { slug: page.slug });
    return noContent(reply);
  });
}

function registerUploadAdminRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;
  const uploadResource = (u: Awaited<ReturnType<typeof loadAdminUploads>>[number]) =>
    resource(CONTENT_TYPES.upload, u.id, (({ id: _id, ...rest }) => rest)(u), { links: { self: `/api/admin/uploads/${u.id}` } });

  // Raw bytes only for this route: a form or a simple cross-site request cannot send this type
  // without a CORS preflight, and the CSRF header is required for cookie sessions anyway.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/api/admin/uploads', admin, async (req) => collection(req, (await loadAdminUploads(db)).map(uploadResource)));

  app.post<{ Querystring: { fileName?: string } }>(
    '/api/admin/uploads',
    { ...admin, bodyLimit: UPLOAD_MAX_BYTES, config: { jsonapi: { requestBody: 'native' }, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/octet-stream') {
        throw new HttpError(415, 'unsupported_media_type', 'Send the image as application/octet-stream', undefined, {
          source: { header: 'Content-Type' },
        });
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { upload, created: isNew } = await storeUpload(db, bytes, cleanFilename(req.query.fileName), owningUserId(req));
      if (isNew) await auditRequest(db, req, 'upload.create', 'upload', upload.id, { url: upload.url, size: upload.size });
      const body = document(uploadResource(upload), { links: { self: selfLink(req) } });
      return isNew ? created(reply, body, `/api/admin/uploads/${upload.id}`) : body;
    },
  );

  app.delete('/api/admin/uploads/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const [upload] = await loadAdminUploads(db, id);
    if (!upload) throw notFound('Upload');
    await db.deleteFrom('uploads').where('id', '=', id).execute();
    await auditRequest(db, req, 'upload.delete', 'upload', id, { url: upload.url });
    return noContent(reply);
  });
}
