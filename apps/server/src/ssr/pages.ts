/**
 * Server-side rendered public pages (all roles that serve the public web client).
 *
 * The web build has a render bundle (apps/web/dist/.ssr/entry-server.mjs, see
 * apps/web/src/entry-server.tsx). It is imported on the first page request only
 * and renders the React route tree of the public pages against the in-process
 * public API (source.ts). The built public.html is the page template: its script,
 * modulepreload and stylesheet tags (from the Vite manifest) stay as they are;
 * <html lang/dir/data-theme>, the head data of the page, the markup and the
 * state block are filled in.
 *
 * Memory (public instances stay below 100 MB, docs/architecture.md#memory): one
 * page renders at a time, a few wait; beyond 4 waiting pages a request gets the
 * last rendered version of the page at once, even an expired one, or, when
 * there is none, the plain client-rendered entry page, which costs no render
 * (a personal page gets a 503 busy page with Retry-After instead). Graceful
 * degradation under a flood: under 64 concurrent connections that kept the
 * public instance below 100 MB, with 2 renders and 32 waiting it reached 110 MB.
 * A rendered page is kept for a few seconds per URL (only the query parameters
 * the pages read) and language/theme input as UTF-8 bytes (a bounded map:
 * entries and bytes; concurrent requests for the same key share one render)
 * and is sent with an ETag and a short shared Cache-Control. After that it
 * stays in the same bounded map for a stale window (10 minutes) to answer when
 * no render slot is free or a render fails. Only pages rendered with status
 * 200 are kept, and the least recently used one is dropped first, so requests
 * for countless unknown URLs cannot push the pages visitors use out of the
 * map. A render error without such a copy is logged and the caller sends the
 * plain client-rendered page instead.
 *
 * The analytics opt-out cookie is part of the cache key (entry-server.tsx), so a
 * page rendered with the analytics script never answers a visitor who turned it
 * off, and the other way round (Vary: Cookie tells shared caches the same).
 *
 * Pages are sent gzip-compressed to clients that accept it (a page shrinks to
 * about a sixth). The page is compressed once per render, kept with the page,
 * so a cached page costs no CPU per request; Brotli would compress better but
 * costs several times the memory while compressing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  ANALYTICS_PATHS,
  headElements,
  isPersonalPath,
  SSR_STATE_ID,
  THEME_LINK_ATTR,
  THEME_PREVIEW_QUERY,
  type DataDocument,
  type AnalyticsTag,
  type PageHead,
  type SsrFormState,
  type SsrModule,
  type SsrRenderInput,
  type SsrRenderResult,
} from '@openstatuspage/shared';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { PrivatePageDocuments } from '../services/private-page-documents.js';
import type { PublicDocuments } from '../services/public-documents.js';
import { sendBusy } from './busy.js';
import { publicDocumentSource } from './source.js';

export const SSR_BUNDLE = '.ssr/entry-server.mjs';
const TEMPLATE = 'public.html';

/** SSR bundle with its cache key functions (exported by entry-server.tsx). */
export interface RenderModule extends SsrModule {
  cacheKey(input: Pick<SsrRenderInput, 'url' | 'cookie' | 'acceptLanguage'>): string;
  /** The URL a page is rendered with: only the query parameters the pages read. */
  pageUrl(url: string): string;
}

export interface SsrPagesOptions {
  webDir: string;
  baseUrl: string;
  docs: PublicDocuments;
  /** A subscription for its manage token (the manage page without JavaScript); rejects with a 404 HttpError. */
  subscription?: (id: string, token: string) => Promise<DataDocument>;
  /** A webhook or SMS subscription for its manage token (its manage page); rejects with a 404 HttpError. */
  channelSubscription?: (id: string, token: string) => Promise<DataDocument>;
  /** Private pages at /p/<token> (rendered for each request, never cached). */
  privatePages?: PrivatePageDocuments;
  log: FastifyBaseLogger;
  /** Loads the render bundle (default: dist/.ssr/entry-server.mjs of webDir). Tests pass the source module. */
  loadModule?: () => Promise<RenderModule>;
  /** Seconds a rendered page is reused (default 5). */
  cacheSeconds?: number;
  /** Seconds an expired page is still kept to answer when it cannot be rendered (default 600). */
  staleSeconds?: number;
  /** Rendered pages kept at most (default 16). */
  cacheEntries?: number;
  /** Bytes of rendered pages kept at most (default 1 MiB). */
  cacheBytes?: number;
  /** Pages rendered at the same time (default 1). */
  concurrency?: number;
  /** Pages waiting for a render at most; more get a stale page or 503 at once (default 4). */
  maxWaiting?: number;
  /** Stylesheets of the active theme (services/themes.ts) and of a preview for signed-in admins. */
  theme?: SsrThemeOptions;
}

export interface SsrThemeOptions {
  /** The active theme's stylesheet URLs (`/theme/<hash>.css`). */
  stylesheets(): Promise<string[]>;
  /**
   * The stylesheets of a theme preview (`?theme=<id>`) when the request may see
   * one (a signed-in admin); null otherwise: the page is the usual one.
   */
  preview?(req: FastifyRequest): Promise<string[] | null>;
}

interface RenderedPage {
  status: number;
  /** UTF-8: half the memory of a JavaScript string with non-ASCII characters. */
  body: Buffer;
  /** The body gzip-compressed. */
  gzip: Buffer;
  etag: string;
  /** Until then the page is reused (fresh). */
  expires: number;
  /** Until then the expired page answers when no fresh one can be rendered (stale). */
  staleUntil: number;
}

/** A page for a request: fresh, or an expired copy and why no fresh one was rendered. */
interface PageAnswer {
  page: RenderedPage;
  /** Set when the page is an expired copy, with the error of the fresh render. */
  stale?: { error: unknown };
}

/** A full render queue is logged at most this often. */
const QUEUE_WARNING_MS = 10_000;

/** Longest URL that is rendered; longer ones get the plain page. */
const MAX_URL = 2048;

/** Cache-Control of rendered pages: short, shared, served stale while a fresh one renders. */
export const PAGE_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=60';
/** An expired copy sent under load: briefly, so clients and proxies ask again soon. */
export const STALE_CACHE_CONTROL = 'public, max-age=5';
/** Personal links (subscription confirm/manage) and answers to forms: never stored. */
const PRIVATE_CACHE_CONTROL = 'private, no-store';

/** A page answering a form submission (see sendForm). */
export interface FormPage {
  /** Page (path and query) to render, e.g. "/subscribe". */
  url: string;
  form: SsrFormState;
  /** HTTP status (422 for invalid input, 429 when rate limited). */
  status: number;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Head elements of a page (the same ones the browser updates, see apps/web/src/public/head.tsx). */
export function headTags(head: PageHead, hoisted: string): string {
  const tags = [`<title>${escapeHtml(head.title)}</title>`];
  for (const el of headElements(head)) {
    const attrs = Object.entries(el.attrs)
      .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
      .join('');
    // Script text is JSON escaped with scriptJson (no `<`): it cannot end the element.
    tags.push(el.tag === 'script' ? `<script${attrs}>${el.text ?? ''}</script>` : `<${el.tag}${attrs}>`);
  }
  if (hoisted) tags.push(hoisted);
  return tags.join('');
}

/**
 * The Umami script tag (routes/analytics.ts proxies script and events): deferred,
 * so it never blocks rendering, and from this site, so the CSP stays 'self'.
 * The URL fragment is left out (it only scrolls within a page).
 */
export function analyticsScriptTag(tag: AnalyticsTag): string {
  const attrs: [string, string][] = [
    ['src', ANALYTICS_PATHS.script],
    ['data-website-id', tag.websiteId],
    ['data-host-url', ANALYTICS_PATHS.host],
    ['data-exclude-hash', 'true'],
  ];
  if (tag.domains) attrs.push(['data-domains', tag.domains]);
  if (tag.doNotTrack) attrs.push(['data-do-not-track', 'true']);
  return `<script defer${attrs.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')}></script>`;
}

/** The built public.html, split around the parts a rendered page fills in. */
export interface PageTemplate {
  /** From `<!doctype html>` up to (excluding) `<html ...>`. */
  beforeHtml: string;
  /** `<head>` start up to where the page head goes (after charset and viewport). */
  headStart: string;
  /** Rest of the head (assets) and the body up to the root element's content. */
  headRestAndBodyStart: string;
  /** After the root element's content. */
  end: string;
}

export function parseTemplate(html: string): PageTemplate {
  // The template's own title and description are replaced by the page's.
  const cleaned = html.replace(/<title>[^<]*<\/title>\s*/i, '').replace(/<meta\s+name="description"[^>]*>\s*/i, '');
  const htmlTag = /<html\b[^>]*>/i.exec(cleaned);
  const root = /<div id="root"><\/div>/.exec(cleaned);
  if (!htmlTag || !root) throw new Error(`${TEMPLATE} has no <html> or no empty <div id="root">`);
  const afterHtml = htmlTag.index + htmlTag[0].length;
  const viewport = /<meta\s+name="viewport"[^>]*>/i.exec(cleaned);
  const headOpen = /<head>/i.exec(cleaned);
  const headAt = viewport ? viewport.index + viewport[0].length : headOpen ? headOpen.index + headOpen[0].length : afterHtml;
  const rootContent = root.index + '<div id="root">'.length;
  return {
    beforeHtml: cleaned.slice(0, htmlTag.index),
    headStart: cleaned.slice(afterHtml, headAt),
    headRestAndBodyStart: cleaned.slice(headAt, rootContent),
    end: cleaned.slice(rootContent),
  };
}

/**
 * Link elements of the theme stylesheets: same-origin paths only (anything else is dropped).
 * The browser keeps them; the client adds them itself only on a page the server did not render.
 */
export function themeLinks(stylesheets: readonly string[]): string {
  return stylesheets
    .filter((href) => /^\/theme\/[0-9a-f]+\.css$/.test(href))
    .map((href) => `<link rel="stylesheet" href="${href}" ${THEME_LINK_ATTR}>`)
    .join('');
}

export function composePage(template: PageTemplate, page: SsrRenderResult, stylesheets: readonly string[] = []): string {
  const theme = page.theme === 'system' ? '' : ` data-theme="${page.theme}"`;
  // After the app's stylesheet (end of <head>): the extra CSS of a theme overrides it.
  const links = themeLinks(stylesheets);
  const rest = links ? template.headRestAndBodyStart.replace(/<\/head>/i, `${links}</head>`) : template.headRestAndBodyStart;
  return (
    `${template.beforeHtml}<html lang="${escapeHtml(page.lang)}" dir="${page.dir}"${theme}>` +
    template.headStart +
    headTags(page.head, page.hoisted) +
    (page.analytics ? analyticsScriptTag(page.analytics) : '') +
    rest +
    page.html +
    // Data, not code: type=application/json is never executed.
    `</div><script type="application/json" id="${SSR_STATE_ID}">${page.state}</script>` +
    template.end.replace(/^<\/div>/, '')
  );
}

/** Level 6: nearly the size of level 9 at a fraction of the time. */
const GZIP_LEVEL = 6;

/** Whether the client accepts a gzip-compressed response (Accept-Encoding, q > 0). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  let gzip: boolean | undefined;
  let any = false;
  for (const part of value.split(',')) {
    const [coding = '', ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const accepted = q === undefined || Number(q.slice(2)) > 0;
    if (coding.trim() === 'gzip' || coding.trim() === 'x-gzip') gzip = accepted;
    else if (coding.trim() === '*') any = accepted;
  }
  return gzip ?? any;
}

const etagOf = (body: Buffer) => `W/"${createHash('sha1').update(body).digest('base64url')}"`;

/** Thrown when too many pages wait for a render: a stale page or 503 answers instead. */
export class RenderQueueFull extends Error {
  constructor() {
    super('Too many pages waiting for server-side rendering');
    this.name = 'RenderQueueFull';
  }
}

/** Counting semaphore: at most `limit` holders, at most `maxWaiting` waiting in order. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      if (this.waiting.length >= this.maxWaiting) throw new RenderQueueFull();
      // The slot is handed over by the holder that finishes (active stays the same).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class SsrPages {
  private module: Promise<RenderModule> | null = null;
  private template: PageTemplate | null = null;
  private readonly cache = new Map<string, RenderedPage>();
  private cachedBytes = 0;
  private readonly inFlight = new Map<string, Promise<RenderedPage>>();
  private readonly source;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly limiter: Limiter;
  /** Set when the bundle cannot be loaded: every page is the plain one, logged once. */
  private unavailable = false;
  /** Requests refused by the full queue since the last warning (of them answered stale), and when it was logged. */
  private queueFullCount = 0;
  private queueFullStale = 0;
  private queueWarnedAt = -Infinity;

  constructor(private readonly options: SsrPagesOptions) {
    this.source = publicDocumentSource(options.docs, {
      subscription: options.subscription,
      channelSubscription: options.channelSubscription,
      privatePages: options.privatePages,
    });
    this.ttlMs = (options.cacheSeconds ?? 5) * 1000;
    this.staleMs = (options.staleSeconds ?? 600) * 1000;
    this.maxEntries = options.cacheEntries ?? 16;
    this.maxBytes = options.cacheBytes ?? 1024 * 1024;
    this.limiter = new Limiter(options.concurrency ?? 1, options.maxWaiting ?? 4);
  }

  /** Whether the web build has a render bundle at all. */
  static available(webDir: string): boolean {
    return existsSync(join(webDir, SSR_BUNDLE)) && existsSync(join(webDir, TEMPLATE));
  }

  private loadModule(): Promise<RenderModule> {
    this.module ??= (
      this.options.loadModule ?? (() => import(pathToFileURL(join(this.options.webDir, SSR_BUNDLE)).href) as Promise<RenderModule>)
    )();
    return this.module;
  }

  private loadTemplate(): PageTemplate {
    this.template ??= parseTemplate(readFileSync(join(this.options.webDir, TEMPLATE), 'utf8'));
    return this.template;
  }

  /** Entries and bytes of the render cache (fresh and stale pages). */
  get cacheSize(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cachedBytes };
  }

  /**
   * Sends the rendered page for a public client route: fresh, or the last
   * rendered version when no fresh one can be rendered, or (personal pages
   * only) 503 when the queue is full and there is none. Resolves false when the
   * page could not be rendered otherwise (the caller sends the plain
   * client-rendered page).
   */
  async send(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (this.unavailable || req.url.length > MAX_URL) return false;
    if (this.options.theme?.preview && hasPreviewQuery(req.url)) {
      const preview = await this.options.theme.preview(req).catch((err: unknown) => {
        req.log.error({ err }, 'Theme preview failed; sending the page with the active theme');
        return null;
      });
      if (preview) return this.sendPreview(req, reply, preview);
    }
    let answer: PageAnswer;
    try {
      answer = await this.render(req);
    } catch (err) {
      if (err instanceof RenderQueueFull) {
        this.queueFull(req.log, false);
        // The client-rendered entry page costs no render; a personal page gets the busy page,
        // so nothing of it is ever answered without its own render.
        if (!isPersonalPath(req.url)) return false;
        await sendBusy(req, reply);
        return true;
      }
      req.log.error({ err }, 'Server-side rendering failed; sending the client-rendered page');
      return false;
    }
    const { page } = answer;
    const stale = answer.stale !== undefined;
    if (answer.stale?.error instanceof RenderQueueFull) this.queueFull(req.log, true);
    else if (stale) req.log.error({ err: answer.stale?.error }, 'Server-side rendering failed; sending the last rendered version');

    const personal = isPersonalPath(req.url);
    reply
      .header('Cache-Control', personal ? PRIVATE_CACHE_CONTROL : stale ? STALE_CACHE_CONTROL : PAGE_CACHE_CONTROL)
      // Language and theme come from these headers.
      .header('Vary', 'Accept-Language, Cookie, Accept-Encoding')
      .header('ETag', page.etag);
    if (stale) reply.header('X-Cache', 'STALE');
    if (!personal && page.status === 200 && req.headers['if-none-match'] === page.etag) {
      await reply.status(304).send();
      return true;
    }
    await sendPage(req, reply.status(page.status), page);
    return true;
  }

  /** A theme preview for a signed-in admin: rendered for this request only, never stored. */
  private async sendPreview(req: FastifyRequest, reply: FastifyReply, stylesheets: string[]): Promise<boolean> {
    let rendered: RenderedPage;
    try {
      const module = await this.module_();
      rendered = await this.limiter.run(() => this.renderPage(module, this.inputOf(req), stylesheets));
    } catch (err) {
      if (err instanceof RenderQueueFull) this.queueFull(req.log, false);
      else req.log.error({ err }, 'Server-side rendering of a theme preview failed');
      return false;
    }
    reply
      .status(rendered.status)
      .header('Cache-Control', PRIVATE_CACHE_CONTROL)
      .header('Vary', 'Accept-Language, Cookie, Accept-Encoding')
      .header('X-Robots-Tag', 'noindex, nofollow');
    await sendPage(req, reply, rendered);
    return true;
  }

  /**
   * Answers a form submission with the page itself (submitted values, errors),
   * rendered for this request only. Resolves false when it cannot be rendered;
   * the caller then redirects to the plain page with an error code.
   */
  async sendForm(req: FastifyRequest, reply: FastifyReply, page: FormPage): Promise<boolean> {
    if (this.unavailable) return false;
    let rendered: RenderedPage;
    try {
      const module = await this.module_();
      rendered = await this.limiter.run(() => this.renderPage(module, { ...this.inputOf(req), url: page.url, form: page.form }));
    } catch (err) {
      if (err instanceof RenderQueueFull) this.queueFull(req.log, false);
      else req.log.error({ err }, 'Server-side rendering of a form answer failed');
      return false;
    }
    reply
      .status(page.status)
      .header('Cache-Control', PRIVATE_CACHE_CONTROL)
      .header('Vary', 'Accept-Language, Cookie, Accept-Encoding');
    await sendPage(req, reply, rendered);
    return true;
  }

  /**
   * Counts a request the full queue refused (answered with a stale page or not)
   * and logs it at most once per QUEUE_WARNING_MS with the counts (a flood of
   * thousands of requests is one line, not thousands).
   */
  private queueFull(log: FastifyBaseLogger, stale: boolean): void {
    this.queueFullCount++;
    if (stale) this.queueFullStale++;
    const now = Date.now();
    if (now - this.queueWarnedAt < QUEUE_WARNING_MS) return;
    log.warn(
      { requests: this.queueFullCount, stale: this.queueFullStale },
      'Too many pages waiting for server-side rendering; sent stale, client-rendered or busy pages',
    );
    this.queueWarnedAt = now;
    this.queueFullCount = 0;
    this.queueFullStale = 0;
  }

  private async module_(): Promise<RenderModule> {
    try {
      return await this.loadModule();
    } catch (err) {
      this.unavailable = true;
      this.options.log.error({ err }, 'Cannot load the server-side rendering bundle; serving client-rendered pages');
      throw err;
    }
  }

  private inputOf(req: FastifyRequest) {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v.join(', ') : v;
    };
    return { url: req.url, cookie: header('cookie'), acceptLanguage: header('accept-language') };
  }

  private async renderPage(
    module: RenderModule,
    input: Pick<SsrRenderInput, 'url' | 'cookie' | 'acceptLanguage' | 'form'>,
    stylesheets?: string[],
  ): Promise<RenderedPage> {
    const [result, sheets] = await Promise.all([
      module.render({ ...input, source: this.source, baseUrl: this.options.baseUrl, now: Date.now() }),
      stylesheets ?? this.options.theme?.stylesheets() ?? [],
    ]);
    const body = Buffer.from(composePage(this.loadTemplate(), result, sheets));
    const gzip = gzipSync(body, { level: GZIP_LEVEL });
    const expires = Date.now() + this.ttlMs;
    return { status: result.status, body, gzip, etag: etagOf(body), expires, staleUntil: expires + this.staleMs };
  }

  private async render(req: FastifyRequest): Promise<PageAnswer> {
    const module = await this.module_();
    const request = this.inputOf(req);
    // Personal pages (a token in the URL) are neither kept nor shared between requests,
    // in any spelling of the path (the router matches /SUBSCRIPTION/manage as well),
    // and never answered stale.
    if (isPersonalPath(request.url)) return { page: await this.limiter.run(() => this.renderPage(module, request)) };
    // Rendered without the query parameters no page reads: /?x=1, /?x=2 ... share one
    // render instead of forcing a new one each (the cache key is the same URL).
    const input = { ...request, url: module.pageUrl(request.url) };
    const key = module.cacheKey(input);
    const now = Date.now();

    let cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      this.touch(key, cached);
      return { page: cached };
    }
    if (cached && cached.staleUntil <= now) {
      this.evict(key);
      cached = undefined;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.limiter
        .run(() => this.renderPage(module, input))
        .then((page) => {
          this.remember(key, page);
          return page;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    try {
      return { page: await pending };
    } catch (err) {
      // Queue full or render error: the last rendered version, if there is one.
      if (!cached) throw err;
      if (this.cache.get(key) === cached) this.touch(key, cached);
      return { page: cached, stale: { error: err } };
    }
  }

  private remember(key: string, page: RenderedPage): void {
    // Only real pages: a 404 for each of countless unknown URLs would push the pages
    // visitors ask for (and their stale copies, the fallback under load) out of the cache.
    if (page.status !== 200 || this.ttlMs <= 0 || pageBytes(page) > this.maxBytes) return;
    this.evict(key);
    this.cache.set(key, page);
    this.cachedBytes += pageBytes(page);
    // Least recently used first: drop beyond the limits.
    while (this.cache.size > this.maxEntries || this.cachedBytes > this.maxBytes) this.evict(this.cache.keys().next().value!);
    // Pages past the stale window do not wait for the next request of their key.
    setTimeout(() => {
      if (this.cache.get(key) === page) this.evict(key);
    }, this.ttlMs + this.staleMs).unref();
  }

  /** Marks a page as just used: it is dropped last (the map keeps insertion order). */
  private touch(key: string, page: RenderedPage): void {
    this.cache.delete(key);
    this.cache.set(key, page);
  }

  private evict(key: string): void {
    const page = this.cache.get(key);
    if (!page) return;
    this.cache.delete(key);
    this.cachedBytes -= pageBytes(page);
  }
}

/** Whether the URL asks for a theme preview (`?theme=<id>`). */
function hasPreviewQuery(url: string): boolean {
  const query = url.indexOf('?');
  return query !== -1 && new URLSearchParams(url.slice(query + 1)).has(THEME_PREVIEW_QUERY);
}

const pageBytes = (page: RenderedPage) => page.body.length + page.gzip.length;

/** Sends a rendered page, gzip-compressed when the client accepts it. */
async function sendPage(req: FastifyRequest, reply: FastifyReply, page: RenderedPage): Promise<void> {
  reply.type('text/html; charset=utf-8');
  if (acceptsGzip(req.headers['accept-encoding'])) {
    await reply.header('Content-Encoding', 'gzip').send(page.gzip);
  } else {
    await reply.send(page.body);
  }
}
