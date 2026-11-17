import { SubscribeInput, type PublicService, type PublicServiceGroup } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  hashParam,
  knownServiceIds,
  linkParams,
  managePath,
  sectionServiceIds,
  selectionState,
  serviceSections,
  setSelected,
  subscriptionErrors,
  toSubscriptionLocale,
} from './subscription';

const service = (id: string, groupId: string | null = null): PublicService => ({
  id,
  slug: id,
  name: `Service ${id}`,
  description: null,
  kind: 'service',
  url: null,
  groupId,
  status: 'operational',
  locationIds: [],
  uptimePercent: null,
});

const group = (id: string, services: PublicService[]): PublicServiceGroup => ({
  id,
  slug: id,
  name: `Group ${id}`,
  description: null,
  collapsedByDefault: false,
  status: 'operational',
  services,
});

describe('serviceSections', () => {
  it('lists groups in order, then ungrouped services, and drops empty sections', () => {
    const sections = serviceSections(
      [group('g1', [service('a', 'g1'), service('b', 'g1')]), group('g2', []), group('g3', [service('c', 'g3')])],
      [service('d')],
    );
    expect(sections.map((s) => s.id)).toEqual(['g1', 'g3', null]);
    expect(sections[0]!.services).toEqual([
      { id: 'a', name: 'Service a' },
      { id: 'b', name: 'Service b' },
    ]);
    expect(sections[2]!.name).toBeNull();
    expect(sectionServiceIds(sections)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('omits the ungrouped section when every service has a group', () => {
    expect(serviceSections([group('g1', [service('a', 'g1')])], []).map((s) => s.id)).toEqual(['g1']);
  });
});

describe('selectionState', () => {
  it('reports all, some or none', () => {
    expect(selectionState(['a', 'b'], ['a', 'b'])).toBe('all');
    expect(selectionState(['a', 'x'], ['a', 'b'])).toBe('some');
    expect(selectionState(['x'], ['a', 'b'])).toBe('none');
    expect(selectionState(['a'], [])).toBe('none');
  });
});

describe('setSelected', () => {
  it('adds missing ids after the existing selection without duplicates', () => {
    expect(setSelected(['b', 'x'], ['a', 'b', 'c'], true)).toEqual(['b', 'x', 'a', 'c']);
    expect(setSelected(['a', 'a'], ['a'], true)).toEqual(['a']);
  });

  it('removes all given ids', () => {
    expect(setSelected(['a', 'x', 'b'], ['a', 'b'], false)).toEqual(['x']);
  });
});

describe('knownServiceIds', () => {
  it('drops ids that are no longer offered', () => {
    const sections = serviceSections([group('g1', [service('a', 'g1')])], [service('b')]);
    expect(knownServiceIds(['a', 'gone', 'b'], sections)).toEqual(['a', 'b']);
  });
});

describe('toSubscriptionLocale', () => {
  it('maps UI languages to supported locales', () => {
    expect(toSubscriptionLocale('de')).toBe('de');
    expect(toSubscriptionLocale('de-AT')).toBe('de');
    expect(toSubscriptionLocale('EN-us')).toBe('en');
    expect(toSubscriptionLocale('fr')).toBe('en');
    expect(toSubscriptionLocale(undefined)).toBe('en');
  });
});

describe('hashParam', () => {
  it('reads and decodes a fragment parameter', () => {
    expect(hashParam('#token=a%2Bb', 'token')).toBe('a+b');
    expect(hashParam('token=x+y&other=1', 'token')).toBe('x+y');
    expect(hashParam('#other=1&token=t0k', 'token')).toBe('t0k');
  });

  it('returns null when absent or malformed', () => {
    expect(hashParam('', 'token')).toBeNull();
    expect(hashParam('#tokens=x', 'token')).toBeNull();
    expect(hashParam('#token=%E0%A4%A', 'token')).toBeNull();
  });
});

describe('linkParams', () => {
  it('reads the id from the query and the token from the fragment', () => {
    expect(linkParams(new URLSearchParams('id=abc'), '#token=t0k')).toEqual({ id: 'abc', token: 't0k' });
    expect(linkParams(new URLSearchParams('id=abc&unsubscribe=1'), '#token=a-b_c')).toEqual({ id: 'abc', token: 'a-b_c' });
  });

  it('prefers the fragment token over a query token', () => {
    expect(linkParams(new URLSearchParams('id=abc&token=old'), '#token=new')).toEqual({ id: 'abc', token: 'new' });
  });

  it('falls back to a token in the query', () => {
    expect(linkParams(new URLSearchParams('id=abc&token=t0k'))).toEqual({ id: 'abc', token: 't0k' });
    expect(linkParams(new URLSearchParams('id=abc&token=t0k'), '#token=%20')).toEqual({ id: 'abc', token: 't0k' });
    expect(linkParams(new URLSearchParams('id=abc&token=t0k'), '#token=%E0%A4%A')).toEqual({ id: 'abc', token: 't0k' });
  });

  it('returns null when a value is missing or blank', () => {
    expect(linkParams(new URLSearchParams('id=abc'))).toBeNull();
    expect(linkParams(new URLSearchParams('id=abc'), '#')).toBeNull();
    expect(linkParams(new URLSearchParams(''), '#token=t0k')).toBeNull();
    expect(linkParams(new URLSearchParams('token=t0k'))).toBeNull();
    expect(linkParams(new URLSearchParams('id=%20'), '#token=t0k')).toBeNull();
  });

  it('round-trips through managePath with the token in the fragment', () => {
    const path = managePath('a b', 'x+y/z=');
    expect(path.startsWith('/subscription/manage?')).toBe(true);
    const url = new URL(path, 'https://status.example.com');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('unsubscribe')).toBe(false);
    expect(linkParams(url.searchParams, url.hash)).toEqual({ id: 'a b', token: 'x+y/z=' });
  });

  it('adds unsubscribe=1 to the query when asked', () => {
    const url = new URL(managePath('abc', 't0k', { unsubscribe: true }), 'https://status.example.com');
    expect(url.pathname).toBe('/subscription/manage');
    expect(url.searchParams.get('unsubscribe')).toBe('1');
    expect(url.hash).toBe('#token=t0k');
  });
});

describe('subscriptionErrors', () => {
  it('maps client-side validation issues to field messages', () => {
    const res = SubscribeInput.safeParse({ email: 'not-an-email', allServices: false, serviceIds: [] });
    expect(res.success).toBe(false);
    expect(subscriptionErrors(res.error!.issues)).toEqual({
      email: 'subscription.errors.email',
      serviceIds: 'subscription.errors.services',
    });
  });

  it('treats invalid service ids as an outdated selection', () => {
    expect(subscriptionErrors([{ code: 'invalid_value', path: ['serviceIds', 0] }])).toEqual({
      serviceIds: 'subscription.errors.servicesInvalid',
    });
  });

  it('turns other issues and malformed input into a form error', () => {
    expect(subscriptionErrors([{ code: 'too_big', path: ['website'] }])).toEqual({ form: 'subscription.errors.invalid' });
    expect(subscriptionErrors(undefined)).toEqual({ form: 'subscription.errors.invalid' });
    expect(subscriptionErrors([])).toEqual({ form: 'subscription.errors.invalid' });
  });
});
