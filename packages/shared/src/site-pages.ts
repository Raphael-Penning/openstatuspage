/**
 * Content pages of the public status page (docs/configuration.md#pages):
 *
 * - four system pages with fixed paths: the about page (/about), the legal
 *   notice (/legal-notice, "Impressum"), the privacy policy (/privacy) and the
 *   accessibility statement (/accessibility). Each is either an internal page
 *   (published, Markdown per language) or, while unpublished, the external link
 *   of the settings (infoLinkUrl, imprintUrl, privacyUrl, accessibilityUrl) as
 *   before;
 * - any number of custom pages at /pages/<slug>.
 *
 * Markdown is rendered by the web client without raw HTML (react-markdown).
 * Images are uploads of the instance (/uploads/<sha256>.<ext>, see uploads.ts)
 * or https URLs.
 */
import { z } from 'zod';

/** System pages; the key is also their slug and their path (`/<key>`). */
export const SYSTEM_PAGE_KEYS = ['about', 'legal-notice', 'privacy', 'accessibility'] as const;
export type SystemPageKey = (typeof SYSTEM_PAGE_KEYS)[number];

export function isSystemPageKey(value: unknown): value is SystemPageKey {
  return typeof value === 'string' && (SYSTEM_PAGE_KEYS as readonly string[]).includes(value);
}

/** Path prefix of the custom pages. */
export const CUSTOM_PAGE_PREFIX = '/pages/';

/** Languages of the page content (the public UI languages). */
export const PAGE_CONTENT_LANGUAGES = ['en', 'de'] as const;
export type PageContentLanguage = (typeof PAGE_CONTENT_LANGUAGES)[number];

/** A text per content language. */
export interface LocalizedText {
  en: string;
  de: string;
}

/** Path of a page on the public site: `/<key>` for system pages, `/pages/<slug>` for the others. */
export function sitePagePath(page: { systemKey: SystemPageKey | null; slug: string }): string {
  return page.systemKey ? `/${page.systemKey}` : `${CUSTOM_PAGE_PREFIX}${page.slug}`;
}

/** The text in `lang`, falling back to the other language when it is empty. */
export function localizedText(value: LocalizedText, lang: string): string {
  const own = lang === 'de' ? value.de : value.en;
  if (own.trim()) return own;
  return (lang === 'de' ? value.en : value.de) ?? '';
}

/** Slug of a custom page: lower case letters, digits and single dashes, at most 64 characters. */
export const zPageSlug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower case letters, digits and dashes only');

/** Single-line text (titles, descriptions): no control characters. */
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'single line')
    .default('');

const localized = (field: z.ZodType<string>) => z.object({ en: field, de: field }).default({ en: '', de: '' });

/** Longest Markdown body per language. */
export const PAGE_BODY_MAX = 50_000;

/**
 * POST/PATCH /api/admin/pages. A system page ignores `slug`, `showInFooter`,
 * `showInNav` and `sortOrder` (its place on the page is fixed).
 */
export const SitePageInput = z
  .object({
    slug: zPageSlug,
    title: localized(singleLine(120)),
    /** Meta description; empty: the start of the text. */
    description: localized(singleLine(300)),
    /** Markdown, no raw HTML. */
    body: localized(z.string().max(PAGE_BODY_MAX).default('')),
    /** Shown on the public page (system pages: replaces the external link). */
    published: z.boolean().default(false),
    showInFooter: z.boolean().default(true),
    showInNav: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine((p, ctx) => {
    if (!p.title.en && !p.title.de) {
      ctx.addIssue({ code: 'custom', path: ['title', 'en'], message: 'a title in at least one language is required' });
    }
  });
export type SitePageInput = z.infer<typeof SitePageInput>;

/** Width and height of an uploaded image in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/** A page as the management API returns it. */
export interface AdminSitePage {
  id: string;
  /** Set for the four system pages (they cannot be deleted). */
  systemKey: SystemPageKey | null;
  slug: string;
  /** Path on the public site. */
  path: string;
  title: LocalizedText;
  description: LocalizedText;
  body: LocalizedText;
  published: boolean;
  showInFooter: boolean;
  showInNav: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A published page as the public API returns it (GET /api/public/pages/{slug}). */
export interface PublicSitePage {
  id: string;
  systemKey: SystemPageKey | null;
  slug: string;
  path: string;
  title: LocalizedText;
  description: LocalizedText;
  body: LocalizedText;
  /** Sizes of the uploaded images the text shows, by their path (no layout shift). */
  images: Record<string, ImageSize>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A published page in the navigation of the public page (part of the public
 * settings document): system pages replace their external link, custom pages
 * appear in the footer and/or the header navigation, by `sortOrder`.
 */
export interface PublicSitePageLink {
  systemKey: SystemPageKey | null;
  slug: string;
  path: string;
  title: LocalizedText;
  showInFooter: boolean;
  showInNav: boolean;
  sortOrder: number;
}

/** The public settings document: the page settings plus what the pages derive from the database. */
export interface PublicSiteExtras {
  /** Published pages for the footer and the navigation. */
  pages?: PublicSitePageLink[];
  /** Size of the logo when it is an upload of this instance (width/height attributes). */
  logoSize?: ImageSize | null;
}

/** Upload paths in a text (`/uploads/<sha256>.<ext>`), each once. */
export function uploadPathsIn(text: string): string[] {
  return [...new Set(text.match(/\/uploads\/[0-9a-f]{64}\.(?:png|jpg|webp|ico)\b/g) ?? [])];
}
