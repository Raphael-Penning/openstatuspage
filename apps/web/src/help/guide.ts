/**
 * Loads the setup and operations guide from docs/guide/<lang>/*.md (the single
 * source, also read on GitHub). Every file becomes its own lazy chunk, so the
 * guide never ends up in the public bundle.
 */
import { guideSummary, guideTitle, parseGuidePath, topicSlug } from './markdown';

/** Language whose file set defines the topics; other languages fall back to it per file. */
export const GUIDE_REFERENCE_LANG = 'en';

const loaders = import.meta.glob<string>('../../../../docs/guide/*/*.md', { query: '?raw', import: 'default' });

const files = new Map<string, () => Promise<string>>();
for (const [path, load] of Object.entries(loaders)) {
  const parsed = parseGuidePath(path);
  if (parsed) files.set(`${parsed.lang}/${parsed.file}`, load);
}

export interface GuideTopic {
  slug: string;
  file: string;
  title: string;
  summary: string;
  markdown: string;
  /** Language of the markdown (differs from the requested one when it fell back). */
  lang: string;
}

/** File names of the reference language, in display order. */
export function guideFiles(): string[] {
  return [...files.keys()]
    .filter((k) => k.startsWith(`${GUIDE_REFERENCE_LANG}/`))
    .map((k) => k.slice(GUIDE_REFERENCE_LANG.length + 1))
    .sort();
}

/** Loads all topics for a language, falling back to the reference language per file. */
export async function loadGuide(lang: string): Promise<GuideTopic[]> {
  return Promise.all(
    guideFiles().map(async (file) => {
      const ownLoader = files.get(`${lang}/${file}`);
      const topicLang = ownLoader ? lang : GUIDE_REFERENCE_LANG;
      const markdown = await (ownLoader ?? files.get(`${GUIDE_REFERENCE_LANG}/${file}`)!)();
      const slug = topicSlug(file);
      return { slug, file, title: guideTitle(markdown) ?? slug, summary: guideSummary(markdown), markdown, lang: topicLang };
    }),
  );
}
