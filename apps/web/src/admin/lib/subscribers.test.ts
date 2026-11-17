import { describe, expect, it } from 'vitest';
import { pageAfterEnd, subscriberParams, subscriberQueryFromParams, subscriberScope } from './subscribers';

const parse = (qs: string) => subscriberQueryFromParams(new URLSearchParams(qs), 50);

describe('subscriberQueryFromParams', () => {
  it('uses defaults for an empty URL', () => {
    expect(parse('')).toEqual({ page: 1, pageSize: 50, status: 'all' });
  });

  it('reads page, status and search', () => {
    expect(parse('page=3&status=pending&q=%20example.com%20')).toEqual({
      page: 3,
      pageSize: 50,
      status: 'pending',
      q: 'example.com',
    });
  });

  it('keeps valid parts when others are invalid', () => {
    expect(parse('page=-2&status=bogus&q=alice')).toEqual({ page: 1, pageSize: 50, status: 'all', q: 'alice' });
  });
});

describe('subscriberParams', () => {
  it('omits defaults', () => {
    expect(subscriberParams({ page: 1, status: 'all', q: undefined })).toEqual({});
    expect(subscriberParams({ page: 2, status: 'confirmed', q: 'bob' })).toEqual({ page: '2', status: 'confirmed', q: 'bob' });
  });

  it('round-trips through subscriberQueryFromParams', () => {
    const query = { page: 4, pageSize: 50, status: 'pending' as const, q: 'example.org' };
    expect(subscriberQueryFromParams(new URLSearchParams(subscriberParams(query)), 50)).toEqual(query);
  });
});

describe('subscriberScope', () => {
  it('describes all updates or the selected services', () => {
    expect(subscriberScope({ allServices: true, services: [] }, 'All updates')).toBe('All updates');
    expect(
      subscriberScope(
        {
          allServices: false,
          services: [
            { id: 'a', name: 'API' },
            { id: 'b', name: 'Website' },
          ],
        },
        'All updates',
      ),
    ).toBe('API, Website');
    expect(subscriberScope({ allServices: false, services: [] }, 'All updates')).toBe('–');
  });
});

describe('pageAfterEnd', () => {
  const page = (page: number, total: number, items: number) => ({ items: Array.from({ length: items }), total, page, pageSize: 50 });

  it('jumps to the last page when the current page is past the end', () => {
    expect(pageAfterEnd(page(3, 100, 0))).toBe(2);
    expect(pageAfterEnd(page(9, 51, 0))).toBe(2);
    expect(pageAfterEnd(page(2, 50, 0))).toBe(1);
    expect(pageAfterEnd(page(4, 3, 0))).toBe(1);
  });

  it('stays on pages with entries, the first page and empty lists', () => {
    expect(pageAfterEnd(page(2, 100, 50))).toBeNull();
    expect(pageAfterEnd(page(1, 10, 0))).toBeNull();
    expect(pageAfterEnd(page(3, 0, 0))).toBeNull();
  });

  it('always moves backwards on an inconsistent response', () => {
    expect(pageAfterEnd(page(2, 120, 0))).toBe(1);
  });
});
