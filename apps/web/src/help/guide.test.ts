import { describe, expect, it } from 'vitest';
import { guideFiles, loadGuide } from './guide';
import { extractHeadings, parseGuidePath, resolveHelpLink, topicSlug } from './markdown';

const raw = import.meta.glob<string>('../../../../docs/guide/*/*.md', { query: '?raw', import: 'default', eager: true });

/** Repository files the guide may link to (keys only; nothing is loaded). */
const repoFiles = new Set(
  Object.keys(
    import.meta.glob([
      '../../../../docs/**/*.md',
      '../../../../docker/*',
      '../../../../contrib/**/*',
      '../../../../*.md',
      '../../../../deploy/**/*.md',
      '../../../../.env.example',
    ]),
  ).map((k) => k.replace(/^(\.\.\/)+/, '')),
);

const guide = new Map<string, Map<string, string>>();
for (const [path, markdown] of Object.entries(raw)) {
  const parsed = parseGuidePath(path)!;
  if (!guide.has(parsed.lang)) guide.set(parsed.lang, new Map());
  guide.get(parsed.lang)!.set(parsed.file, markdown);
}

/** Inline links outside code (fenced and inline). */
function links(markdown: string): string[] {
  const withoutCode = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');
  return [...withoutCode.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

describe('setup and operations guide', () => {
  it('exists in English and German with the same files', () => {
    expect([...guide.keys()].sort()).toEqual(['de', 'en']);
    const en = [...guide.get('en')!.keys()].sort();
    const de = [...guide.get('de')!.keys()].sort();
    expect(en.length).toBeGreaterThanOrEqual(10);
    expect(de).toEqual(en);
    expect(guideFiles()).toEqual(en);
  });

  it('has unique topic slugs', () => {
    const slugs = guideFiles().map(topicSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('starts every file with a single top-level heading', () => {
    for (const [lang, files] of guide) {
      for (const [file, markdown] of files) {
        const headings = extractHeadings(markdown);
        expect(markdown.trimStart().startsWith('# '), `${lang}/${file}`).toBe(true);
        expect(headings.filter((h) => h.depth === 1), `${lang}/${file}`).toHaveLength(1);
      }
    }
  });

  it('has no broken links', () => {
    const broken: string[] = [];
    for (const [lang, files] of guide) {
      const topics = new Map([...files].map(([file, md]) => [topicSlug(file), md]));
      for (const [file, markdown] of files) {
        const ownIds = new Set(extractHeadings(markdown).map((h) => h.id));
        for (const href of links(markdown)) {
          const target = resolveHelpLink(href, lang);
          const where = `${lang}/${file}: ${href}`;
          if (target.kind === 'anchor' && !ownIds.has(target.hash)) broken.push(where);
          if (target.kind === 'topic') {
            const [path, hash] = target.to.split('#');
            const md = topics.get(path!.split('/').pop()!);
            if (!md) broken.push(where);
            else if (hash && !extractHeadings(md).some((h) => h.id === hash)) broken.push(where);
          }
          if (target.kind === 'repo' && !repoFiles.has(target.path)) broken.push(where);
          if (target.kind === 'external' && !/^(https:|mailto:)/.test(href)) broken.push(where);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('loads a language with its own titles', async () => {
    const de = await loadGuide('de');
    const en = await loadGuide('en');
    expect(de.map((t) => t.slug)).toEqual(en.map((t) => t.slug));
    expect(de.every((t) => t.lang === 'de' && t.title.length > 0 && t.summary.length > 0)).toBe(true);
    expect((await loadGuide('fr')).every((t) => t.lang === 'en')).toBe(true);
  });
});
