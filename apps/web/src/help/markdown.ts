/**
 * Pure helpers for the help area: topic slugs, heading anchors and the mapping
 * of links inside the guide (docs/guide/<lang>/*.md) to help routes. No Vite or
 * React dependencies, so everything here is unit tested.
 */

export const HELP_BASE_PATH = '/admin/help';

/** "02-installation.md" → "installation" (numeric ordering prefix removed). */
export function topicSlug(file: string): string {
  return file.replace(/\.md$/i, '').replace(/^\d+[-_]/, '');
}

/** Splits a glob key like "../../../../docs/guide/en/01-overview.md" into language and file name. */
export function parseGuidePath(path: string): { lang: string; file: string } | null {
  const m = /(?:^|\/)docs\/guide\/([^/]+)\/([^/]+\.md)$/.exec(path);
  return m ? { lang: m[1]!, file: m[2]! } : null;
}

/**
 * Heading anchor in the style of GitHub: lower case, punctuation removed,
 * spaces become hyphens. Links like `09-operations.md#secret_key` work both on
 * GitHub and in the help area.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Returns a slug function that de-duplicates repeated headings ("setup", "setup-1", ...). */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base)! + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

/** Removes inline markdown (code ticks, links, strong emphasis) from heading text. */
export function plainText(inline: string): string {
  return inline
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

export interface GuideHeading {
  depth: number;
  text: string;
  id: string;
}

/** ATX headings outside fenced code blocks, with the ids the renderer assigns. */
export function extractHeadings(markdown: string): GuideHeading[] {
  const slug = createSlugger();
  const headings: GuideHeading[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = plainText(m[2]!);
    headings.push({ depth: m[1]!.length, text, id: slug(text) });
  }
  return headings;
}

/** Text of the first level-1 heading, used as topic title. */
export function guideTitle(markdown: string): string | null {
  return extractHeadings(markdown).find((h) => h.depth === 1)?.text ?? null;
}

/** First paragraph after the title as plain text, for the topic overview. */
export function guideSummary(markdown: string, maxLength = 220): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#\s/.test(l));
  const paragraph: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^(#|\||```|~~~|>|\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  const text = plainText(paragraph.join(' ')).replace(/\*/g, '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export type HelpLink =
  /** Another guide topic, rendered as a client-side route. */
  | { kind: 'topic'; to: string }
  /** A heading in the current topic. */
  | { kind: 'anchor'; hash: string }
  /** Absolute URL (https:, mailto:, ...), opened in a new tab. */
  | { kind: 'external'; href: string }
  /** Another file of the repository (e.g. docs/configuration.md), not served by the app. */
  | { kind: 'repo'; path: string };

/**
 * Maps a link found in `docs/guide/<lang>/<file>` to its target in the help area.
 * Relative links to other guide files become help routes (in the current UI
 * language); links to other repository files are reported as such.
 */
export function resolveHelpLink(href: string, lang: string): HelpLink {
  if (href.startsWith('#')) return { kind: 'anchor', hash: href.slice(1) };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'external', href };

  const hashIndex = href.indexOf('#');
  const pathPart = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex + 1);

  const segments = pathPart.startsWith('/') ? [] : ['docs', 'guide', lang];
  for (const part of pathPart.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return { kind: 'repo', path: pathPart.replace(/^(\.\.\/)+/, '') };
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  const resolved = segments.join('/');
  const guide = parseGuidePath(resolved);
  if (guide && segments.length === 4) {
    return { kind: 'topic', to: `${HELP_BASE_PATH}/${topicSlug(guide.file)}${hash ? `#${hash}` : ''}` };
  }
  if (pathPart === '' && hash) return { kind: 'anchor', hash };
  return { kind: 'repo', path: resolved };
}

// ---------------------------------------------------------------------------
// rehype plugin: heading ids
// ---------------------------------------------------------------------------

/** The parts of a hast node this module needs. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/** Gives every heading an id (same algorithm as `extractHeadings`). */
export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = createSlugger();
    const walk = (node: HastNode) => {
      if (node.type === 'element' && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        node.properties = { ...node.properties, id: slug(hastText(node).trim()) };
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
