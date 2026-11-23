import { describe, expect, it } from 'vitest';
import openapi from '../../../../../docs/openapi.json';
import {
  canTry,
  constraints,
  credentialInputs,
  exampleBody,
  exampleOf,
  groupByTag,
  matchesQuery,
  pathValueProblem,
  requestUrl,
  resolve,
  typeLabel,
  type OpenApiDocument,
  type ResponseObject,
} from './spec';

const doc = openapi as unknown as OpenApiDocument;
const op = (path: string, method: string) => doc.paths[path]![method]!;

describe('the API documentation helpers', () => {
  it('group every operation by its tag, in the order of the tags', () => {
    const groups = groupByTag(doc);
    expect(groups.map((g) => g.name)).toEqual(doc.tags!.map((t) => t.name));
    const total = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
    expect(groups.reduce((n, g) => n + g.operations.length, 0)).toBe(total);
  });

  it('match on method, path and summary words', () => {
    const [create] = groupByTag(doc).flatMap((g) => g.operations).filter((o) => o.operation.operationId === 'postAdminIncidents');
    expect(matchesQuery(create!, 'post incidents')).toBe(true);
    expect(matchesQuery(create!, 'POST /api/admin/incidents')).toBe(true);
    expect(matchesQuery(create!, 'get incidents')).toBe(false);
    expect(matchesQuery(create!, '  ')).toBe(true);
  });

  it('resolve references and describe types and constraints', () => {
    const notFound = resolve<ResponseObject>(doc, { $ref: '#/components/responses/NotFound' });
    expect(notFound.description).toContain('Unknown resource');
    expect(typeLabel(doc, { $ref: '#/components/schemas/ServiceInput' })).toBe('ServiceInput');
    expect(typeLabel(doc, { anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(typeLabel(doc, { type: 'array', items: { type: 'string' } })).toBe('array<string>');
    expect(constraints({ type: 'string', minLength: 1, maxLength: 120 })).toEqual(['length: 1–120']);
    // zod's safe integer bounds are no constraint worth showing.
    expect(constraints({ type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991, default: 0 })).toEqual(['default: 0']);
  });

  it('build example bodies from the documented example or the schema', () => {
    const login = op('/api/auth/login', 'post').requestBody!.content['application/vnd.api+json'];
    expect(JSON.parse(exampleBody(doc, login))).toEqual({ data: { type: 'sessions', attributes: { email: 'admin@example.com', password: '…' } } });
    const location = op('/api/admin/locations', 'post').requestBody!.content['application/vnd.api+json'];
    expect(JSON.parse(exampleBody(doc, location))).toEqual({ data: { type: 'locations' } });
    expect(exampleOf(doc, { type: 'object', required: ['at'], properties: { at: { type: 'string', format: 'date-time' } } })).toEqual({
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('build same-origin URLs only, with encoded path values', () => {
    const origin = 'https://status.example.com';
    expect(requestUrl('/api/admin/services/{id}', { id: 'a/b?c' }, { 'filter[status]': 'active', empty: '' }, origin)).toBe(
      '/api/admin/services/a%2Fb%3Fc?filter[status]=active',
    );
    expect(() => requestUrl('//evil.example.net/x', {}, {}, origin)).toThrow();
    expect(() => requestUrl('https://evil.example.net/x', {}, {}, origin)).toThrow();
  });

  it('refuse empty and dot path parameter values', () => {
    expect(pathValueProblem('')).toBe('empty');
    expect(pathValueProblem(undefined)).toBe('empty');
    expect(pathValueProblem('.')).toBe('dot');
    expect(pathValueProblem('..')).toBe('dot');
    expect(pathValueProblem('...')).toBeNull();
    expect(pathValueProblem('svc_1')).toBeNull();
    for (const id of ['', '.', '..']) {
      expect(() => requestUrl('/api/admin/incidents/{id}/updates', { id }, {}, origin)).toThrow();
    }
    expect(() => requestUrl('/api/admin/services/{id}', {}, {}, origin)).toThrow();
  });

  it('ask for tokens only where the session does not do', () => {
    expect(credentialInputs(doc, op('/api/admin/services', 'get'))).toEqual([]);
    expect(credentialInputs(doc, op('/api/public/status', 'get'))).toEqual([]);
    expect(credentialInputs(doc, op('/api/public/subscriptions/{id}', 'get')).map((c) => c.definition.name)).toEqual(['X-Subscription-Token']);
    expect(credentialInputs(doc, op('/api/ingest/{sourceId}', 'post')).map((c) => c.scheme)).toEqual(['ingestToken']);
  });

  it('do not offer to try redirects and uploads', () => {
    expect(canTry(op('/api/auth/oidc/login', 'get'))).toBe(false);
    expect(canTry(op('/api/admin/uploads', 'post'))).toBe(false);
    expect(canTry(op('/api/admin/incidents', 'post'))).toBe(true);
  });
});
