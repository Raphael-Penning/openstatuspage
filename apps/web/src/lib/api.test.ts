import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

const MEDIA = 'application/vnd.api+json';
const calls: { url: string; init: RequestInit }[] = [];
let next: { status: number; body?: unknown };

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: { 'content-type': MEDIA } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const headers = (i = 0) => calls[i]!.init.headers as Record<string, string>;

describe('api', () => {
  it('deserializes data documents', async () => {
    next = {
      status: 200,
      body: {
        jsonapi: { version: '1.1' },
        data: { type: 'incidents', id: 'i1', attributes: { title: 'Down' }, relationships: { updates: { data: [{ type: 'incident-updates', id: 'u1' }] } } },
        included: [{ type: 'incident-updates', id: 'u1', attributes: { message: 'Looking' } }],
      },
    };
    const incident = await api.get('/api/public/incidents/i1');
    expect(incident).toEqual({ id: 'i1', title: 'Down', updateIds: ['u1'], updates: [{ id: 'u1', message: 'Looking' }] });
    expect(headers().accept).toBe(MEDIA);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('builds JSON:API query parameters for pages', async () => {
    next = { status: 200, body: { jsonapi: { version: '1.1' }, data: [], meta: { total: 0, page: { number: 2, size: 5 } } } };
    const page = await api.getPage('/api/public/history', { page: { number: 2, size: 5 }, filter: { type: 'incident' } });
    expect(page).toEqual({ items: [], total: 0, page: 2, pageSize: 5 });
    expect(calls[0]!.url).toBe('/api/public/history?page[number]=2&page[size]=5&filter[type]=incident');
  });

  it('wraps request bodies as resource objects', async () => {
    next = { status: 201, body: { jsonapi: { version: '1.1' }, data: { type: 'services', id: 's1', attributes: { name: 'API' } } } };
    const created = await api.post('/api/admin/services', { name: 'API', groupId: 'g1' }, { relationships: { groupId: 'service-groups' } });
    expect(created).toEqual({ id: 's1', name: 'API' });
    expect(headers()['content-type']).toBe(MEDIA);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      data: { type: 'services', attributes: { name: 'API' }, relationships: { group: { data: { type: 'service-groups', id: 'g1' } } } },
    });

    next = { status: 204 };
    await api.patch('/api/admin/services/0d9f6c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', { name: 'B' }, { id: '0d9f6c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f' });
    expect(JSON.parse(calls[1]!.init.body as string).data).toMatchObject({ type: 'services', id: '0d9f6c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f' });

    await api.post('/api/auth/logout');
    expect(calls[2]!.init.body).toBeUndefined();
    expect(headers(2)['content-type']).toBeUndefined();
  });

  it('returns meta of meta-only documents and raw bodies of other responses', async () => {
    next = { status: 200, body: { jsonapi: { version: '1.1' }, meta: { sent: 3 } } };
    expect(await api.post('/api/x/test', {})).toEqual({ sent: 3 });
    next = { status: 200, body: { status: 'ok' } };
    expect(await api.get('/api/health')).toEqual({ status: 'ok' });
  });

  it('maps JSON:API errors to ApiError with field issues', async () => {
    next = {
      status: 400,
      body: {
        jsonapi: { version: '1.1' },
        errors: [
          { status: '400', code: 'too_small', title: 'Invalid request', detail: 'Too short', source: { pointer: '/data/attributes/name' }, meta: { minimum: 1 } },
          { status: '400', code: 'invalid_format', detail: 'Invalid id', source: { pointer: '/data/relationships/services/data/0' } },
        ],
      },
    };
    const err = await api.post('/api/admin/services', { name: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe('Too short');
    expect(apiError.errors).toHaveLength(2);
    expect(apiError.body).toEqual({
      error: 'too_small',
      message: 'Too short',
      issues: [
        { path: ['name'], message: 'Too short', code: 'too_small', minimum: 1 },
        { path: ['serviceIds', 0], message: 'Invalid id', code: 'invalid_format' },
      ],
    });

    next = { status: 404, body: { jsonapi: { version: '1.1' }, errors: [{ status: '404', code: 'not_found', title: 'Not Found', detail: 'Incident not found' }] } };
    const missing = (await api.get('/api/public/incidents/x').catch((e: unknown) => e)) as ApiError;
    expect(missing.body).toEqual({ error: 'not_found', message: 'Incident not found' });
  });
});
