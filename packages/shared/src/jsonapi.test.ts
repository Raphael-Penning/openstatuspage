import { describe, expect, it } from 'vitest';
import {
  deserialize,
  deserializeDocument,
  deserializePage,
  errorIssues,
  flattenResource,
  inferResourceType,
  pointerToPath,
  relationshipKey,
  relationshipNameForKey,
  toQueryParams,
  toRequestDocument,
  type DataDocument,
} from './jsonapi.js';

describe('relationship naming', () => {
  it('maps relationship names to plain keys and back', () => {
    expect(relationshipKey('group', false)).toBe('groupId');
    expect(relationshipKey('services', true)).toBe('serviceIds');
    expect(relationshipKey('activeIncidents', true)).toBe('activeIncidentIds');
    expect(relationshipKey('categories', true)).toBe('categoryIds');
    expect(relationshipNameForKey('serviceIds')).toEqual({ name: 'services', many: true });
    expect(relationshipNameForKey('categoryIds')).toEqual({ name: 'categories', many: true });
    expect(relationshipNameForKey('groupId')).toEqual({ name: 'group', many: false });
    expect(relationshipNameForKey('name')).toBeNull();
    expect(relationshipNameForKey('Id')).toBeNull();
  });
});

describe('toRequestDocument / flattenResource', () => {
  it('wraps attributes and moves listed fields into relationships', () => {
    const doc = toRequestDocument(
      'services',
      { name: 'API', groupId: 'g1', locationIds: ['l1', 'l2'], skipped: undefined },
      { relationships: { groupId: 'service-groups', locationIds: 'locations' } },
    );
    expect(doc).toEqual({
      data: {
        type: 'services',
        attributes: { name: 'API' },
        relationships: {
          group: { data: { type: 'service-groups', id: 'g1' } },
          locations: {
            data: [
              { type: 'locations', id: 'l1' },
              { type: 'locations', id: 'l2' },
            ],
          },
        },
      },
    });
    expect(flattenResource(doc.data)).toEqual({ name: 'API', groupId: 'g1', locationIds: ['l1', 'l2'] });
  });

  it('keeps null to-one relationships and the id', () => {
    const doc = toRequestDocument('services', { groupId: null }, { id: 's1', relationships: { groupId: 'service-groups' } });
    expect(doc.data).toEqual({ type: 'services', id: 's1', attributes: {}, relationships: { group: { data: null } } });
    expect(flattenResource(doc.data)).toEqual({ groupId: null });
  });

  it('tolerates malformed members', () => {
    expect(flattenResource({ type: 'x', attributes: 'nope' as never, relationships: { a: 'x' as never } })).toEqual({});
  });
});

describe('deserialize', () => {
  const doc: DataDocument = {
    jsonapi: { version: '1.1' },
    data: {
      type: 'service-groups',
      id: 'g1',
      attributes: { name: 'Platform' },
      relationships: {
        services: {
          data: [
            { type: 'services', id: 's1' },
            { type: 'services', id: 's2' },
          ],
        },
      },
    },
    included: [
      {
        type: 'services',
        id: 's1',
        attributes: { name: 'API' },
        relationships: { group: { data: { type: 'service-groups', id: 'g1' } }, owner: { data: null } },
      },
      { type: 'services', id: 's2', attributes: { name: 'Web' }, relationships: { group: { data: { type: 'service-groups', id: 'g1' } } } },
    ],
    meta: { counts: { operational: 2 } },
    links: { self: '/api/x' },
  };

  it('flattens attributes, relationship ids and resolves included resources without cycles', () => {
    const { data, meta, links, included } = deserializeDocument<Record<string, unknown>>(doc);
    expect(data).toEqual({
      id: 'g1',
      name: 'Platform',
      serviceIds: ['s1', 's2'],
      services: [
        { id: 's1', name: 'API', groupId: 'g1', ownerId: null },
        { id: 's2', name: 'Web', groupId: 'g1' },
      ],
    });
    expect(() => JSON.stringify(data)).not.toThrow();
    expect(meta).toEqual({ counts: { operational: 2 } });
    expect(links).toEqual({ self: '/api/x' });
    // Included resources resolve their relations from the primary data.
    expect(included[0]).toMatchObject({ id: 's1', group: { id: 'g1', name: 'Platform' } });
  });

  it('leaves relations unresolved when a related resource is missing', () => {
    const plain = deserialize<Record<string, unknown>>({
      data: { type: 'incidents', id: 'i1', attributes: { title: 'Down' }, relationships: { locations: { data: [{ type: 'locations', id: 'l1' }] } } },
    });
    expect(plain).toEqual({ id: 'i1', title: 'Down', locationIds: ['l1'] });
  });

  it('handles collections, null data and relationships without data', () => {
    expect(deserialize({ data: null })).toBeNull();
    expect(
      deserialize({ data: [{ type: 'a', id: '1', attributes: { x: 1 }, relationships: { b: { links: { related: '/b' } } } }] }),
    ).toEqual([{ id: '1', x: 1 }]);
  });

  it('builds a page result from meta', () => {
    const page = deserializePage({
      data: [{ type: 'a', id: '1', attributes: {} }],
      meta: { total: 41, page: { number: 3, size: 20 } },
    });
    expect(page).toEqual({ items: [{ id: '1' }], total: 41, page: 3, pageSize: 20 });
    expect(deserializePage({ data: [] })).toEqual({ items: [], total: 0, page: 1, pageSize: 0 });
  });
});

describe('inferResourceType', () => {
  it('uses the last non-id path segment', () => {
    expect(inferResourceType('/api/admin/services')).toBe('services');
    expect(inferResourceType('/api/admin/services/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f?x=1')).toBe('services');
    expect(inferResourceType('/api/admin/incidents/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/updates')).toBe('updates');
    expect(inferResourceType('/api/admin/sources/12')).toBe('sources');
    expect(inferResourceType('/api')).toBe('resources');
  });
});

describe('toQueryParams', () => {
  it('builds JSON:API query parameters and skips empty values', () => {
    expect(
      toQueryParams({
        page: { number: 2, size: 10 },
        filter: { type: 'incident', service: undefined, month: '' },
        sort: ['-date', 'id'],
        include: ['updates'],
      }),
    ).toEqual({ 'page[number]': '2', 'page[size]': '10', 'filter[type]': 'incident', sort: '-date,id', include: 'updates' });
    expect(toQueryParams({})).toEqual({});
  });
});

describe('errors', () => {
  it('maps pointers to field paths', () => {
    expect(pointerToPath('/data/attributes/checks/0/checkId')).toEqual(['checks', 0, 'checkId']);
    expect(pointerToPath('/data/attributes/a~1b')).toEqual(['a/b']);
    expect(pointerToPath('/data/relationships/services')).toEqual(['serviceIds']);
    expect(pointerToPath('/data/relationships/services/data/2')).toEqual(['serviceIds', 2]);
    expect(pointerToPath('/data/relationships/group')).toEqual(['groupId']);
    expect(pointerToPath('/data')).toEqual([]);
    expect(pointerToPath('/meta/x')).toBeNull();
  });

  it('turns errors with pointers or meta into issues', () => {
    expect(
      errorIssues([
        { status: '400', code: 'too_small', detail: 'Too short', source: { pointer: '/data/attributes/name' }, meta: { minimum: 1 } },
        { status: '400', code: 'invalid_csv', detail: 'Bad line', meta: { line: 3 } },
        { status: '400', code: 'bad_request', detail: 'Nope', source: { parameter: 'page[size]' } },
      ]),
    ).toEqual([
      { path: ['name'], message: 'Too short', code: 'too_small', minimum: 1 },
      { path: [], message: 'Bad line', code: 'invalid_csv', line: 3 },
    ]);
  });
});
