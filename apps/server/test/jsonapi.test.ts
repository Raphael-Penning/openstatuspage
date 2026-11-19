import rateLimit from '@fastify/rate-limit';
import { deserialize, toRequestDocument, type DataDocument } from '@openstatuspage/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { badRequest, conflict, HttpError, notFound } from '../src/lib/errors.js';
import { collection, created, document, Included, metaDocument, noContent, resource, toMany, toOne } from '../src/lib/jsonapi.js';
import { mapError, pointerFor } from '../src/lib/jsonapi-errors.js';
import { parseFilter, parseInclude, parseListQuery, parsePage, parseSort } from '../src/lib/jsonapi-query.js';
import { registerJsonApi, sendJsonApiError, useJsonApi } from '../src/plugins/jsonapi.js';

const MEDIA = 'application/vnd.api+json';

describe('serializer', () => {
  it('builds resources with relationships and drops id/type from attributes', () => {
    const res = resource(
      'services',
      's1',
      { id: 's1', type: 'x', name: 'API' },
      { relationships: { group: toOne('service-groups', null), locations: toMany('locations', ['l1', 'l1', 'l2']) } },
    );
    expect(res).toEqual({
      type: 'services',
      id: 's1',
      attributes: { name: 'API' },
      relationships: {
        group: { data: null },
        locations: {
          data: [
            { type: 'locations', id: 'l1' },
            { type: 'locations', id: 'l2' },
          ],
        },
      },
    });
    expect(resource('a', '1', {}, { relationships: {} })).toEqual({ type: 'a', id: '1', attributes: {} });
  });

  it('builds compound documents with each resource once', () => {
    const a = resource('a', '1', { x: 1 });
    const b = resource('b', '1', { y: 2 });
    const included = new Included().add(a, b, b);
    expect(included.size).toBe(2);
    expect(included.has('b', '1')).toBe(true);
    const doc = document(a, { included, links: { self: '/a/1' }, meta: { m: 1 } });
    expect(doc).toEqual({ jsonapi: { version: '1.1' }, data: a, included: [b], links: { self: '/a/1' }, meta: { m: 1 } });
    expect(document(null)).toEqual({ jsonapi: { version: '1.1' }, data: null });
    expect(document([a], { included: [a] })).not.toHaveProperty('included');
    expect(metaDocument({ ok: true })).toEqual({ jsonapi: { version: '1.1' }, meta: { ok: true } });
  });

  it('paginates collections with links', () => {
    const req = { url: '/api/x?filter%5Btype%5D=a&page[number]=2&page[size]=10', query: { 'filter[type]': 'a', 'page[number]': '2', 'page[size]': '10' } };
    const doc = collection(req as unknown as FastifyRequest, [], { page: { number: 2, size: 10 }, total: 25 });
    expect(doc.meta).toEqual({ total: 25, page: { number: 2, size: 10 } });
    expect(doc.links).toEqual({
      self: '/api/x?filter[type]=a&page[number]=2&page[size]=10',
      first: '/api/x?filter[type]=a&page[number]=1&page[size]=10',
      prev: '/api/x?filter[type]=a&page[number]=1&page[size]=10',
      next: '/api/x?filter[type]=a&page[number]=3&page[size]=10',
      last: '/api/x?filter[type]=a&page[number]=3&page[size]=10',
    });
    const single = collection({ url: '/api/y', query: {} } as unknown as FastifyRequest, [resource('a', '1', {})]);
    expect(single.meta).toEqual({ total: 1 });
    expect(single.links).toEqual({ self: '/api/y' });
    const empty = collection({ url: '/api/y', query: {} } as unknown as FastifyRequest, [], { page: { number: 1, size: 5 }, total: 0 });
    expect(empty.links).toMatchObject({ prev: null, next: null, last: '/api/y?page[number]=1&page[size]=5' });
  });
});

describe('query parameters', () => {
  it('parses pages with defaults and limits', () => {
    expect(parsePage({})).toEqual({ number: 1, size: 20, offset: 0 });
    expect(parsePage({ 'page[number]': '3', 'page[size]': '5' })).toEqual({ number: 3, size: 5, offset: 10 });
    expect(parsePage({ page: { number: '2' } }, { defaultSize: 50 })).toEqual({ number: 2, size: 50, offset: 50 });
    expect(() => parsePage({ 'page[size]': '101' })).toThrow(HttpError);
    expect(() => parsePage({ 'page[number]': '0' })).toThrow(/page\[number\]/);
    expect(() => parsePage({ 'page[number]': ['1', '2'] })).toThrow(/once/);
  });

  it('validates filters, sort and include', () => {
    const shape = { type: z.enum(['a', 'b']).optional() };
    expect(parseFilter({ 'filter[type]': 'a' }, shape)).toEqual({ type: 'a' });
    try {
      parseFilter({ 'filter[nope]': 'x' }, shape);
      expect.unreachable();
    } catch (err) {
      expect((err as HttpError).source).toEqual({ parameter: 'filter[nope]' });
    }
    expect(() => parseFilter({ 'filter[type]': 'c' }, shape)).toThrow(HttpError);
    expect(parseSort({ sort: '-date,title' }, ['date', 'title'])).toEqual([
      { field: 'date', desc: true },
      { field: 'title', desc: false },
    ]);
    expect(parseSort({}, ['date'], ['-date'])).toEqual([{ field: 'date', desc: true }]);
    expect(() => parseSort({ sort: 'secret' }, ['date'])).toThrow(/not supported/);
    expect([...parseInclude({}, ['updates'], ['updates'])]).toEqual(['updates']);
    expect([...parseInclude({ include: '' }, ['updates'], ['updates'])]).toEqual([]);
    expect(() => parseInclude({ include: 'secrets' }, ['updates'])).toThrow(/not supported/);
    const all = parseListQuery({ 'page[size]': '2', 'filter[type]': 'b' }, { filter: shape });
    expect(all).toMatchObject({ page: { number: 1, size: 2 }, filter: { type: 'b' }, sort: [] });
    expect(() => parseListQuery({ sort: 'x' })).toThrow(HttpError);
  });
});

describe('error mapping', () => {
  it('maps zod issues to pointers', () => {
    const result = z.object({ name: z.string().min(3), serviceIds: z.array(z.string().uuid()) }).safeParse({ name: 'a', serviceIds: ['x'] });
    const { status, errors } = mapError(result.error, new Set(['services']));
    expect(status).toBe(400);
    expect(errors).toEqual([
      expect.objectContaining({ status: '400', code: 'too_small', source: { pointer: '/data/attributes/name' }, meta: expect.objectContaining({ minimum: 3 }) }),
      expect.objectContaining({ status: '400', code: 'invalid_format', source: { pointer: '/data/relationships/services/data/0' } }),
    ]);
    // Without a relationship in the request, foreign keys were sent as attributes.
    expect(pointerFor(['serviceIds', 0])).toBe('/data/attributes/serviceIds/0');
    expect(pointerFor(['groupId'], new Set(['group']))).toBe('/data/relationships/group');
    expect(pointerFor(['a/b', '~'])).toBe('/data/attributes/a~1b/~0');
  });

  it('maps app errors, Fastify errors and unknown errors', () => {
    expect(mapError(notFound('Incident'))).toEqual({
      status: 404,
      errors: [{ status: '404', code: 'not_found', title: 'Not Found', detail: 'Incident not found' }],
    });
    expect(mapError(conflict('Slug taken')).errors[0]).toMatchObject({ status: '409', code: 'conflict' });
    expect(mapError(badRequest('Bad CSV', [{ line: 3, message: 'Bad date' }])).errors).toEqual([
      { status: '400', code: 'bad_request', title: 'Invalid request', detail: 'Bad date', meta: { line: 3 } },
    ]);
    expect(mapError(badRequest('Odd', 'detail')).errors[0]).toMatchObject({ meta: { issues: 'detail' } });
    expect(mapError(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })).errors[0]).toMatchObject({
      status: '429',
      code: 'rate_limited',
    });
    expect(mapError(Object.assign(new Error('Too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' })).errors[0]).toMatchObject({
      code: 'fst_err_ctp_body_too_large',
    });
    expect(mapError(new Error('secret db detail'))).toEqual({
      status: 500,
      errors: [{ status: '500', code: 'internal_error', title: 'Internal Server Error', detail: 'Internal server error' }],
    });
  });
});

describe('JSON:API routes', () => {
  let app: FastifyInstance;
  let lastBody: unknown;

  beforeEach(async () => {
    app = Fastify();
    registerJsonApi(app);
    app.setErrorHandler((err, req, reply) => sendJsonApiError(err, req, reply));
    await app.register(rateLimit, { global: false });
    await app.register(async (scope) => {
      useJsonApi(scope);
      scope.get('/things/:id', async (req) => {
        const { id } = req.params as { id: string };
        if (id === 'missing') throw notFound('Thing');
        return document(resource('things', id, { name: 'A' }));
      });
      scope.post('/things', { config: { jsonapi: { type: 'things' } } }, async (req, reply) => {
        lastBody = req.body;
        const input = z.object({ name: z.string().min(2), ownerId: z.string().nullish() }).parse(req.body);
        return created(reply, document(resource('things', 't1', input)), '/things/t1');
      });
      scope.patch('/things/:id', async (req) => {
        lastBody = req.body;
        return document(resource('things', (req.params as { id: string }).id, req.body as object));
      });
      scope.delete('/things/:id', async (_req, reply) => noContent(reply));
      scope.get('/listed', { config: { jsonapi: { include: true } } }, async (req) => {
        const include = parseInclude(req.query as Record<string, unknown>, ['owner']);
        return metaDocument({ include: [...include] });
      });
      scope.get('/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => metaDocument({ ok: true }));
      scope.get('/query', { schema: { querystring: { type: 'object', properties: { n: { type: 'integer' } } } } }, async () => metaDocument({}));
    });
    await app.register(async (scope) => {
      useJsonApi(scope, { requestBody: 'native' });
      scope.post('/ingest', async (req) => metaDocument({ received: req.body }));
    });
    app.post('/plain', async (req) => ({ body: req.body }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: JSON.stringify(payload), headers: { 'content-type': MEDIA, ...headers } });

  it('answers with the JSON:API media type and without charset', async () => {
    const res = await app.inject({ url: '/things/a' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(MEDIA);
    expect(deserialize(res.json() as DataDocument)).toEqual({ id: 'a', name: 'A' });
  });

  it('creates from a request document: 201, Location, flattened body', async () => {
    const res = await send('POST', '/things', toRequestDocument('things', { name: 'Box', ownerId: 'u1' }, { relationships: { ownerId: 'users' } }));
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe('/things/t1');
    expect(lastBody).toEqual({ name: 'Box', ownerId: 'u1' });
    expect(res.json().data).toEqual({ type: 'things', id: 't1', attributes: { name: 'Box', ownerId: 'u1' } });
  });

  it('accepts profile parameters and rejects other media type parameters', async () => {
    const doc = toRequestDocument('things', { name: 'Box' });
    expect((await send('POST', '/things', doc, { 'content-type': `${MEDIA}; profile="https://example.com/p"` })).statusCode).toBe(201);
    const withParam = await send('POST', '/things', doc, { 'content-type': `${MEDIA}; charset=utf-8` });
    expect(withParam.statusCode).toBe(415);
    expect(withParam.headers['content-type']).toBe(MEDIA);
    expect(withParam.json()).toEqual({
      jsonapi: { version: '1.1' },
      errors: [expect.objectContaining({ status: '415', code: 'unsupported_media_type', source: { header: 'Content-Type' } })],
    });
    expect((await send('POST', '/things', doc, { 'content-type': `${MEDIA}; ext="https://example.com/ext"` })).statusCode).toBe(415);
    const plain = await app.inject({ method: 'POST', url: '/things', payload: { name: 'Box' } });
    expect(plain.statusCode).toBe(415);
  });

  it('negotiates Accept', async () => {
    const get = (accept: string) => app.inject({ url: '/things/a', headers: { accept } });
    expect((await get(`${MEDIA}; ext="x"`)).statusCode).toBe(406);
    expect((await get(`${MEDIA}; ext="x", ${MEDIA}; profile="p"`)).statusCode).toBe(200);
    expect((await get(`${MEDIA};q=0.9`)).statusCode).toBe(200);
    expect((await get('text/html, */*')).statusCode).toBe(200);
    expect((await get(`${MEDIA}; charset=utf-8`)).json().errors[0]).toMatchObject({ status: '406', source: { header: 'Accept' } });
  });

  it('validates the request document', async () => {
    const noData = await send('POST', '/things', { name: 'Box' });
    expect(noData.statusCode).toBe(400);
    expect(noData.json().errors[0]).toMatchObject({ code: 'invalid_document' });
    expect((await send('POST', '/things', { data: { attributes: {} } })).json().errors[0]).toMatchObject({ source: { pointer: '/data' } });
    expect((await send('POST', '/things', { data: { type: 'things', attributes: [] } })).statusCode).toBe(400);
    const wrongType = await send('POST', '/things', { data: { type: 'others', attributes: { name: 'Box' } } });
    expect(wrongType.statusCode).toBe(409);
    expect(wrongType.json().errors[0]).toMatchObject({ code: 'type_mismatch', source: { pointer: '/data/type' } });
    const wrongId = await send('PATCH', '/things/a', { data: { type: 'things', id: 'b', attributes: {} } });
    expect(wrongId.statusCode).toBe(409);
    expect((await send('PATCH', '/things/a', { data: { type: 'things', id: 'a', attributes: { name: 'B' } } })).statusCode).toBe(200);
    const invalidJson = await app.inject({ method: 'POST', url: '/things', payload: '{', headers: { 'content-type': MEDIA } });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json().errors[0].status).toBe('400');
  });

  it('maps validation errors to pointers', async () => {
    const res = await send('POST', '/things', toRequestDocument('things', { name: 'B', ownerId: 5 }, { relationships: { ownerId: 'users' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.map((e: { source: unknown }) => e.source)).toEqual([{ pointer: '/data/attributes/name' }]);
    const query = await app.inject({ url: '/query?n=abc' });
    expect(query.statusCode).toBe(400);
    expect(query.json().errors[0]).toMatchObject({ code: 'validation_error', source: { parameter: 'n' } });
  });

  it('uses JSON:API errors for 404, 204 and rate limiting', async () => {
    const missing = await app.inject({ url: '/things/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().errors[0]).toMatchObject({ status: '404', code: 'not_found', detail: 'Thing not found' });
    const del = await app.inject({ method: 'DELETE', url: '/things/a' });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    expect((await app.inject({ url: '/limited' })).statusCode).toBe(200);
    const limited = await app.inject({ url: '/limited' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toBe(MEDIA);
    expect(limited.json().errors[0]).toMatchObject({ status: '429', code: 'rate_limited' });
  });

  it('rejects include and sort on routes that do not support them', async () => {
    const include = await app.inject({ url: '/things/a?include=owner' });
    expect(include.statusCode).toBe(400);
    expect(include.json().errors[0]).toMatchObject({ code: 'unsupported_include', source: { parameter: 'include' } });
    const sort = await app.inject({ url: '/things/a?sort=name' });
    expect(sort.statusCode).toBe(400);
    expect(sort.json().errors[0]).toMatchObject({ code: 'unsupported_sort', source: { parameter: 'sort' } });
    expect((await app.inject({ method: 'DELETE', url: '/things/a?include=' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/listed?include=owner' })).json().meta).toEqual({ include: ['owner'] });
    expect((await app.inject({ url: '/listed?include=nope' })).json().errors[0].code).toBe('unsupported_include');
    expect((await app.inject({ url: '/listed?sort=name' })).statusCode).toBe(400);
  });

  it('passes native bodies through on ingest-style routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/ingest', payload: { heartbeat: { status: 1 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonapi: { version: '1.1' }, meta: { received: { heartbeat: { status: 1 } } } });
  });

  it('leaves request bodies of routes outside JSON:API alone', async () => {
    const res = await send('POST', '/plain', { data: { type: 'x', attributes: { a: 1 } } });
    expect(res.json()).toEqual({ body: { data: { type: 'x', attributes: { a: 1 } } } });
  });
});
