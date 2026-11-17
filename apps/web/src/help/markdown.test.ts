import { describe, expect, it } from 'vitest';
import {
  createSlugger,
  extractHeadings,
  guideSummary,
  guideTitle,
  parseGuidePath,
  rehypeHeadingIds,
  resolveHelpLink,
  slugify,
  topicSlug,
  type HastNode,
} from './markdown';

describe('topic names', () => {
  it('strips the ordering prefix and extension', () => {
    expect(topicSlug('02-installation.md')).toBe('installation');
    expect(topicSlug('11-security-checklist.md')).toBe('security-checklist');
    expect(topicSlug('faq.md')).toBe('faq');
  });

  it('parses glob keys', () => {
    expect(parseGuidePath('../../../../docs/guide/de/01-overview.md')).toEqual({ lang: 'de', file: '01-overview.md' });
    expect(parseGuidePath('docs/guide/en/09-operations.md')).toEqual({ lang: 'en', file: '09-operations.md' });
    expect(parseGuidePath('docs/configuration.md')).toBeNull();
  });
});

describe('heading slugs', () => {
  it('follows the GitHub style', () => {
    expect(slugify('Reverse proxy and HTTPS')).toBe('reverse-proxy-and-https');
    expect(slugify('SECRET_KEY')).toBe('secret_key');
    expect(slugify('The "Notify subscribers" checkbox')).toBe('the-notify-subscribers-checkbox');
    expect(slugify('Pull or push?')).toBe('pull-or-push');
    expect(slugify('Sicherung und Wiederherstellung')).toBe('sicherung-und-wiederherstellung');
    expect(slugify('Größe & Übersicht')).toBe('größe--übersicht');
  });

  it('de-duplicates repeated headings', () => {
    const slug = createSlugger();
    expect([slug('Setup'), slug('Setup'), slug('Setup'), slug('Setup 1')]).toEqual(['setup', 'setup-1', 'setup-2', 'setup-1-1']);
  });

  it('extracts headings outside code fences', () => {
    const md = ['# Title', '', '```bash', '# not a heading', '```', '## `BASE_URL`', '## [Link](x.md) **bold**', '## Title'].join('\n');
    expect(extractHeadings(md)).toEqual([
      { depth: 1, text: 'Title', id: 'title' },
      { depth: 2, text: 'BASE_URL', id: 'base_url' },
      { depth: 2, text: 'Link bold', id: 'link-bold' },
      { depth: 2, text: 'Title', id: 'title-1' },
    ]);
  });

  it('assigns the same ids when rendering', () => {
    const text = (value: string): HastNode => ({ type: 'text', value });
    const tree: HastNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'h1', children: [text('Title')] },
        { type: 'element', tagName: 'h2', children: [{ type: 'element', tagName: 'code', children: [text('BASE_URL')] }] },
        { type: 'element', tagName: 'p', children: [text('Body')] },
        { type: 'element', tagName: 'h2', children: [text('Title')] },
      ],
    };
    rehypeHeadingIds()(tree);
    const ids = tree.children!.filter((n) => n.tagName?.startsWith('h')).map((n) => n.properties?.id);
    expect(ids).toEqual(extractHeadings('# Title\n## `BASE_URL`\n## Title').map((h) => h.id));
  });

  it('reads title and summary', () => {
    const md = '# Overview\n\nFirst **paragraph** with `code`\nand a [link](x.md).\n\n## Next\n';
    expect(guideTitle(md)).toBe('Overview');
    expect(guideSummary(md)).toBe('First paragraph with code and a link.');
    expect(guideSummary(`# T\n\n${'word '.repeat(100)}`, 20)).toHaveLength(20);
  });
});

describe('help link mapping', () => {
  it('maps guide files to help routes', () => {
    expect(resolveHelpLink('02-installation.md', 'en')).toEqual({ kind: 'topic', to: '/admin/help/installation' });
    expect(resolveHelpLink('./09-operations.md#secret_key', 'de')).toEqual({
      kind: 'topic',
      to: '/admin/help/operations#secret_key',
    });
    expect(resolveHelpLink('../en/03-reverse-proxy.md', 'de')).toEqual({ kind: 'topic', to: '/admin/help/reverse-proxy' });
  });

  it('keeps in-page anchors', () => {
    expect(resolveHelpLink('#trust_proxy', 'en')).toEqual({ kind: 'anchor', hash: 'trust_proxy' });
  });

  it('marks absolute URLs as external', () => {
    expect(resolveHelpLink('https://example.com/docs', 'en')).toEqual({ kind: 'external', href: 'https://example.com/docs' });
    expect(resolveHelpLink('mailto:status@example.com', 'en')).toEqual({ kind: 'external', href: 'mailto:status@example.com' });
    expect(resolveHelpLink('//cdn.example.com/x', 'en')).toEqual({ kind: 'external', href: '//cdn.example.com/x' });
  });

  it('reports other repository files', () => {
    expect(resolveHelpLink('../../configuration.md', 'en')).toEqual({ kind: 'repo', path: 'docs/configuration.md' });
    expect(resolveHelpLink('../../adapters/README.md#generic-push-api', 'de')).toEqual({
      kind: 'repo',
      path: 'docs/adapters/README.md',
    });
    expect(resolveHelpLink('../../../docker/docker-compose.yml', 'en')).toEqual({
      kind: 'repo',
      path: 'docker/docker-compose.yml',
    });
    expect(resolveHelpLink('../../../../outside.md', 'en')).toEqual({ kind: 'repo', path: 'outside.md' });
  });
});
