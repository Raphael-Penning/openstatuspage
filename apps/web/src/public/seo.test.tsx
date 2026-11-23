// @vitest-environment jsdom
/**
 * Head data of the public pages as the server renders it: unique titles,
 * descriptions, canonical and language URLs, link previews, robots and
 * JSON-LD (schema.org types with the properties Google requires), plus the
 * browser side (applyHead) and the pure helpers of seo.ts.
 */
import { headElements, type DataDocument, type PageHead, type PublicDocumentSource } from '@openstatuspage/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { render } from '../entry-server';
import { API_YESTERDAY, history, incident, maintenance, respond, settings } from './a11y/fixtures';
import { historyDocument } from './a11y/documents';
import { installBrowserStubs } from './a11y/harness';
import { applyHead } from './head';
import { validateJsonLd } from './jsonld-check';
import { breadcrumbLd, eventLd, languageAlternates, markdownText, summarize, webPageLd, withLang } from './seo';

const BASE_URL = 'https://status.example.com';

function sourceWith(patch: Record<string, unknown> = {}): PublicDocumentSource {
  return {
    async get(path) {
      const { status, body } = respond('GET', path);
      if (status !== 200) throw Object.assign(new Error('Not found'), { status });
      const doc = structuredClone(body) as DataDocument & { data: { attributes: Record<string, unknown> } };
      if (path === '/api/public/settings') Object.assign(doc.data.attributes, patch);
      return doc;
    },
  };
}

async function headOf(url: string, patch?: Record<string, unknown>): Promise<PageHead> {
  return (await render({ url, source: sourceWith(patch), baseUrl: BASE_URL })).head;
}

type Ld = Record<string, unknown> & { '@type': string };
const ldTypes = (head: PageHead) => (head.jsonLd ?? []).map((o) => (o as Ld)['@type']);
const ld = (head: PageHead, type: string) => (head.jsonLd ?? []).find((o) => (o as Ld)['@type'] === type) as Ld | undefined;

const INDEXABLE: [url: string, path: string][] = [
  ['/', '/'],
  ['/services', '/services'],
  ['/services/api', '/services/api'],
  ['/locations', '/locations'],
  ['/history', '/history'],
  ['/incidents/inc-1', '/incidents/inc-1'],
  ['/maintenance/m-1', '/maintenance/m-1'],
  ['/subscribe', '/subscribe'],
];

beforeAll(() => installBrowserStubs());

describe('head of the indexable pages', () => {
  it.each(INDEXABLE)('%s: canonical, alternates, robots, description, link preview', async (url, path) => {
    const head = await headOf(url);
    expect(head.status ?? 200).toBe(200);
    expect(head.robots).toBe('index, follow');
    expect(head.canonical).toBe(`${BASE_URL}${path}`);
    expect(head.alternates).toEqual([
      { hreflang: 'en', href: `${BASE_URL}${path}?lang=en` },
      { hreflang: 'de', href: `${BASE_URL}${path}?lang=de` },
      { hreflang: 'x-default', href: `${BASE_URL}${path}` },
    ]);
    expect(head.description).toBeTruthy();
    expect(head.description!.length).toBeLessThanOrEqual(160);
    expect(head.siteName).toBe(settings.siteName);
    expect(head.locale).toBe('en_US');
    expect(head.localeAlternates).toEqual(['de_DE']);
    expect(head.themeColor).toBe(settings.accentColor);
    // No logo in the settings: no image tags.
    expect(head.image).toBeUndefined();
  });

  it('gives every page its own title and description', async () => {
    const heads = await Promise.all(INDEXABLE.map(([url]) => headOf(url)));
    expect(new Set(heads.map((h) => h.title)).size).toBe(heads.length);
    expect(new Set(heads.map((h) => h.description)).size).toBe(heads.length);
    expect(heads[0]!.title).toBe(settings.siteName);
    expect(heads[1]!.title).toBe(`Services & Sites · ${settings.siteName}`);
  });

  it('keeps ?lang= in the canonical URL of a language version', async () => {
    const head = await headOf('/services?lang=de&x=1');
    expect(head.canonical).toBe(`${BASE_URL}/services?lang=de`);
    expect(head.locale).toBe('de_DE');
    expect(head.title).toBe(`Dienste & Websites · ${settings.siteName}`);
  });

  it('names the preferred spelling of the path as canonical (case, trailing slash)', async () => {
    expect((await headOf('/SERVICES')).canonical).toBe(`${BASE_URL}/services`);
    expect((await headOf('/services/')).canonical).toBe(`${BASE_URL}/services`);
    expect((await headOf('/Services/api/')).alternates?.at(-1)).toEqual({ hreflang: 'x-default', href: `${BASE_URL}/services/api` });
  });

  it('uses the content of incidents, maintenance windows and services', async () => {
    expect((await headOf('/incidents/inc-1')).description).toBe(summarize(incident.updates[0]!.message));
    expect((await headOf('/maintenance/m-1')).description).toBe(maintenance.description);
    const service = await headOf('/services/api');
    expect(service.title).toMatch(/^API · /);
    expect(service.description).toMatch(/API/);
  });

  it('describes the overview with the page description, or a generated one', async () => {
    expect((await headOf('/')).description).toBe(settings.description);
    expect((await headOf('/', { description: '' })).description).toBe(`Current status, incidents and maintenance of ${settings.siteName}.`);
  });

  it('takes the logo as preview image and Organization logo, absolute', async () => {
    const head = await headOf('/', { logoUrl: '/logo.png' });
    expect(head.image).toBe(`${BASE_URL}/logo.png`);
    expect(ld(head, 'Organization')?.logo).toBe(`${BASE_URL}/logo.png`);
    expect((await headOf('/incidents/inc-1', { logoUrl: 'https://cdn.example.com/l.png' })).image).toBe('https://cdn.example.com/l.png');
  });

  it('leaves an ICO logo out of JSON-LD and the preview image', async () => {
    const home = await headOf('/', { logoUrl: '/uploads/abc.ico' });
    expect(home.image).toBeUndefined();
    expect(ld(home, 'Organization')?.logo).toBeUndefined();
    const incident = await headOf('/incidents/inc-1', { logoUrl: 'https://cdn.example.com/l.ICO?v=2' });
    expect(ld(incident, 'Article')?.image).toBeUndefined();
    expect(ld(incident, 'Article')?.publisher).not.toHaveProperty('logo');
  });
});

describe('JSON-LD', () => {
  it('describes the site and its organization on the overview', async () => {
    const head = await headOf('/');
    expect(ldTypes(head)).toEqual(['WebSite', 'Organization']);
    expect(ld(head, 'WebSite')).toMatchObject({
      '@context': 'https://schema.org',
      name: settings.siteName,
      url: `${BASE_URL}/`,
      inLanguage: 'en',
      publisher: { '@id': `${BASE_URL}/#organization` },
    });
    expect(ld(head, 'Organization')).toMatchObject({ '@id': `${BASE_URL}/#organization`, name: settings.siteName, url: `${BASE_URL}/` });
  });

  it.each([
    ['/services', ['Example Status', 'Services & Sites']],
    ['/services/api', ['Example Status', 'Services & Sites', 'API']],
    ['/history', ['Example Status', 'History']],
    ['/locations', ['Example Status', 'Locations']],
    ['/subscribe', ['Example Status', 'Email notifications']],
    ['/incidents/inc-1', ['Example Status', 'History', incident.title]],
  ])('%s has breadcrumbs from the overview', async (url, names) => {
    const crumbs = ld(await headOf(url), 'BreadcrumbList');
    const items = crumbs?.itemListElement as { '@type': string; position: number; name: string; item: string }[];
    expect(items.map((i) => i.name)).toEqual(names);
    expect(items.map((i) => i.position)).toEqual(names.map((_, i) => i + 1));
    expect(items[0]!.item).toBe(`${BASE_URL}/`);
    expect(items.at(-1)!.item).toBe(`${BASE_URL}${url}`);
    expect(items.every((i) => i['@type'] === 'ListItem' && i.item.startsWith(BASE_URL))).toBe(true);
  });

  it('/incidents/inc-1 is an Article by the organization about the affected services', async () => {
    const url = '/incidents/inc-1';
    const head = await headOf(url, { logoUrl: '/logo.png' });
    expect(head.type).toBe('article');
    expect(ldTypes(head)).toEqual(['Article', 'BreadcrumbList']);
    expect(ld(head, 'Article')).toMatchObject({
      '@context': 'https://schema.org',
      headline: incident.title,
      datePublished: incident.startedAt,
      dateModified: incident.updatedAt,
      url: `${BASE_URL}${url}`,
      mainEntityOfPage: `${BASE_URL}${url}`,
      image: `${BASE_URL}/logo.png`,
      author: { '@type': 'Organization', name: settings.siteName, url: `${BASE_URL}/` },
      publisher: { '@type': 'Organization', name: settings.siteName, logo: { '@type': 'ImageObject', url: `${BASE_URL}/logo.png` } },
      about: incident.affectedServices.map((s) => ({ '@type': 'Service', name: s.name, url: expect.stringMatching(new RegExp(`^${BASE_URL}/services/`)) })),
    });
    // An outage is no event and no special announcement.
    expect(JSON.stringify(head.jsonLd)).not.toMatch(/Event|SpecialAnnouncement/);
  });

  it('/maintenance/m-1 is an Event held online on the status page, organized by the organization', async () => {
    const url = '/maintenance/m-1';
    const head = await headOf(url, { logoUrl: '/logo.png' });
    expect(head.type).toBe('article');
    expect(ldTypes(head)).toEqual(['Event', 'BreadcrumbList']);
    expect(ld(head, 'Event')).toMatchObject({
      '@context': 'https://schema.org',
      name: maintenance.title,
      startDate: maintenance.actualStart ?? maintenance.scheduledStart,
      endDate: maintenance.actualEnd ?? maintenance.scheduledEnd,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      location: { '@type': 'VirtualLocation', url: `${BASE_URL}/` },
      organizer: { '@type': 'Organization', name: settings.siteName, url: `${BASE_URL}/` },
      url: `${BASE_URL}${url}`,
      image: `${BASE_URL}/logo.png`,
    });
  });

  it('marks a cancelled maintenance window as EventCancelled', () => {
    const site = { name: 'Example Status', baseUrl: BASE_URL, lang: 'en' };
    const event = eventLd(site, { name: 'x', description: 'y', startDate: '2026-01-02T00:00:00.000Z', endDate: '2026-01-01T00:00:00.000Z', status: 'cancelled', url: `${BASE_URL}/maintenance/x` });
    expect(event.eventStatus).toBe('https://schema.org/EventCancelled');
    // Never an end before the start.
    expect(event.endDate).toBe(event.startDate);
  });

  it('/services/api is a Service of the organization, without a made-up status property', async () => {
    const head = await headOf('/services/api');
    expect(ldTypes(head)).toEqual(['Service', 'BreadcrumbList']);
    const service = ld(head, 'Service')!;
    expect(service).toMatchObject({
      name: 'API',
      url: `${BASE_URL}/services/api`,
      provider: { '@type': 'Organization', name: settings.siteName, url: `${BASE_URL}/` },
    });
    expect(Object.keys(service).filter((k) => /status/i.test(k))).toEqual([]);
    expect(JSON.stringify(service)).not.toMatch(/operational|degraded|outage/i);
  });

  it.each([
    ['/accessibility', 'WebPage', 'Accessibility statement'],
    ['/pages/faq', 'WebPage', 'FAQ'],
  ])('%s is a %s of the site with breadcrumbs', async (url, type, title) => {
    const head = await headOf(url);
    expect(head.title).toBe(`${title} · ${settings.siteName}`);
    expect(head.canonical).toBe(`${BASE_URL}${url}`);
    expect(head.alternates?.map((a) => a.hreflang)).toEqual(['en', 'de', 'x-default']);
    expect(ldTypes(head)).toEqual([type, 'BreadcrumbList']);
    expect(ld(head, type)).toMatchObject({
      name: title,
      url: `${BASE_URL}${url}`,
      inLanguage: 'en',
      isPartOf: { '@type': 'WebSite', url: `${BASE_URL}/` },
      publisher: { '@type': 'Organization', name: settings.siteName },
    });
  });

  it('uses the page description, or the start of its text', async () => {
    expect((await headOf('/accessibility')).description).toBe('How accessible this status page is.');
    expect((await headOf('/pages/faq')).description).toBe('How often is the status updated? Every minute.');
    expect((await headOf('/pages/faq?lang=de')).description).toBe('Wie oft wird der Status aktualisiert? Jede Minute.');
  });

  it('makes the about page an AboutPage about the organization', () => {
    const site = { name: 'Example Status', baseUrl: BASE_URL, lang: 'de' };
    const page = webPageLd(site, { type: 'AboutPage', name: 'Über', description: 'd', url: `${BASE_URL}/about`, datePublished: '2026-01-01T00:00:00.000Z', dateModified: '2026-01-02T00:00:00.000Z' });
    expect(page).toMatchObject({ '@type': 'AboutPage', about: { '@type': 'Organization', name: 'Example Status' }, inLanguage: 'de' });
  });

  it('the schema check itself rejects unknown types and properties, missing fields and bad values', () => {
    const bad = { '@context': 'https://schema.org', '@type': 'Event', name: 'x', status: 'operational', startDate: 'today', location: { '@type': 'Place' } };
    const problems = validateJsonLd(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        '$: Event has no property status',
        '$.startDate: not an ISO 8601 date-time',
        '$: Event needs eventStatus',
        '$.location: unknown @type Place',
      ]),
    );
    expect(validateJsonLd({ '@type': 'SpecialAnnouncement' })).toContain('$: unknown @type SpecialAnnouncement');
  });

  it.each([...INDEXABLE.map(([url]) => url), '/accessibility', '/pages/faq'])('%s: every JSON-LD object passes the schema check', async (url) => {
    const head = await headOf(url, { logoUrl: '/logo.png', brandUrl: 'https://www.example.com/' });
    expect(head.jsonLd?.length).toBeGreaterThan(0);
    for (const obj of head.jsonLd ?? []) expect(validateJsonLd(obj), JSON.stringify(obj)).toEqual([]);
  });

  it('is valid JSON in the head elements, also with markup in the data', async () => {
    const head = await headOf('/incidents/inc-1', { siteName: 'A </script><script>alert(1)</script>' });
    const scripts = headElements(head).filter((el) => el.tag === 'script');
    expect(scripts).toHaveLength(2);
    for (const el of scripts) {
      expect(el.text).not.toContain('<');
      expect(() => JSON.parse(el.text!)).not.toThrow();
    }
  });
});

describe('variants of a page: followed, not indexed', () => {
  it.each([
    '/history?type=incident',
    '/history?page=2',
    '/history?month=2026-01',
    '/services?q=api',
    '/services?status=operational',
    '/?upcoming=all',
    '/subscribe?sent=1',
    '/subscribe?error=invalid',
    // Day pages: thin, one per service and day.
    `/services/api/days/${API_YESTERDAY}`,
  ])('%s: noindex, follow, no canonical or alternates', async (url) => {
    const head = await headOf(url);
    expect(head.status ?? 200).toBe(200);
    expect(head.robots).toBe('noindex, follow');
    expect(head.canonical).toBeNull();
    expect(head.alternates).toBeUndefined();
    expect(head.jsonLd).toBeUndefined();
  });

  it('a history page beyond the last one is not found (404)', async () => {
    const source = sourceWith();
    const empty: PublicDocumentSource = {
      async get(path, query) {
        const doc = await source.get(path, query);
        if (path === '/api/public/history' && query?.['page[number]'] === '99') return historyDocument({ ...history, items: [], page: 99 });
        return doc;
      },
    };
    const result = await render({ url: '/history?page=99', source: empty, baseUrl: BASE_URL });
    expect(result.status).toBe(404);
    expect(result.head.robots).toBe('noindex');
  });
});

describe('pages that are not indexed', () => {
  it.each([
    ['/subscription/confirm?id=sub-1', 200],
    ['/subscription/manage?id=sub-1&token=x', 200],
    ['/does-not-exist', 404],
    ['/incidents/missing', 404],
    ['/services/missing', 404],
    ['/legal-notice', 404],
    ['/pages/missing', 404],
    ['/pages/accessibility', 404],
  ])('%s: noindex, no canonical, alternates or JSON-LD', async (url, status) => {
    const head = await headOf(url);
    expect(head.status ?? 200).toBe(status);
    expect(head.robots).toBe('noindex');
    expect(head.canonical).toBeNull();
    expect(head.alternates).toBeUndefined();
    expect(head.jsonLd).toBeUndefined();
  });
});

describe('applyHead', () => {
  const count = (selector: string) => document.head.querySelectorAll(selector).length;

  it('replaces the elements of the previous page and the template description', async () => {
    document.head.innerHTML = '<title>Status</title><meta name="description" content="template"><link rel="alternate" type="application/rss+xml" href="/feed.rss">';
    applyHead(await headOf('/incidents/inc-1'));
    expect(document.title).toBe(`${incident.title} · ${settings.siteName}`);
    expect(count('meta[name="description"]')).toBe(1);
    expect(count('script[type="application/ld+json"]')).toBe(2);
    expect(document.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('article');

    applyHead(await headOf('/services'));
    expect(count('meta[name="description"]')).toBe(1);
    expect(count('link[rel="canonical"]')).toBe(1);
    expect(count('link[hreflang]')).toBe(3);
    expect(count('script[type="application/ld+json"]')).toBe(1);
    expect(document.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('website');
    // Hoisted elements of the pages stay.
    expect(count('link[type="application/rss+xml"]')).toBe(1);

    applyHead(null);
    expect(count('[data-osp-head]')).toBe(0);
  });
});

describe('seo helpers', () => {
  it('summarize keeps short text and cuts long text at a word', () => {
    expect(summarize('  Short\n text. ')).toBe('Short text.');
    const long = summarize('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('word…')).toBe(true);
    expect(summarize('x'.repeat(200)).length).toBe(160);
  });

  it('markdownText keeps the words of Markdown', () => {
    expect(markdownText('# Title\n\nSome **bold** [link](https://example.com) and ![img](/x.png)\n\n- item\n\n```\ncode\n```')).toBe(
      'Title Some bold link and item',
    );
  });

  it('markdownText stays fast on long and unbalanced Markdown', () => {
    for (const body of ['['.repeat(50_000), '<'.repeat(50_000), '!['.repeat(25_000), '[a]('.repeat(12_500)]) {
      const start = performance.now();
      const text = markdownText(body);
      expect(performance.now() - start).toBeLessThan(100);
      expect(text.length).toBeLessThanOrEqual(2000);
    }
    expect(markdownText(`Intro words\n\n${'x '.repeat(30_000)}`).startsWith('Intro words x x')).toBe(true);
  });

  it('builds language URLs and breadcrumbs', () => {
    expect(withLang('/a', 'de')).toBe('/a?lang=de');
    expect(withLang('/a', null)).toBe('/a');
    expect(languageAlternates('/', BASE_URL).map((a) => a.hreflang)).toEqual(['en', 'de', 'x-default']);
    const list = breadcrumbLd({ name: 'S', baseUrl: BASE_URL, lang: 'en' }, [{ name: 'History', path: '/history' }]);
    expect(list).toMatchObject({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1 }, { position: 2, item: `${BASE_URL}/history` }] });
  });
});
