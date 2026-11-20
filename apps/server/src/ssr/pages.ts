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
 * Memory (public instances stay below 100 MB, docs/architecture.md#memory): at
 * most two pages render at a time, the others wait; beyond 32 waiting pages a
 * request gets the plain page at once (graceful degradation under a flood). A rendered page is kept for a
 * few seconds per URL (only the query parameters the pages read) and language/theme input as UTF-8 bytes (a bounded map:
 * entries and bytes; concurrent requests for the same key share one render) and
 * is sent with an ETag and a short shared Cache-Control. Any error is logged and
 * the caller sends the plain client-rendered page instead.
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
  headElements,
  isPersonalPath,
  SSR_STATE_ID,
  type DataDocument,
  type PageHead,
  type SsrFormState,
  type SsrModule,
  type SsrRenderInput,
  type SsrRenderResult,
} from '@openstatuspage/shared';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicDocuments } from '../services/public-documents.js';
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
  log: FastifyBaseLogger;
  /** Loads the render bundle (default: dist/.ssr/entry-server.mjs of webDir). Tests pass the source module. */
  loadModule?: () => Promise<RenderModule>;
  /** Seconds a rendered page is reused (default 5). */
  cacheSeconds?: number;
  /** Rendered pages kept at most (default 16). */
  cacheEntries?: number;
  /** Bytes of rendered pages kept at most (default 1 MiB). */
  cacheBytes?: number;
  /** Pages rendered at the same time (default 2). */
  concurrency?: number;
  /** Pages waiting for a render at most; more get the plain page at once (default 32). */
  maxWaiting?: number;
}

interface RenderedPage {
  status: number;
  /** UTF-8: half the memory of a JavaScript string with non-ASCII characters. */
  body: Buffer;
  /** The body gzip-compressed. */
  gzip: Buffer;
  etag: string;
  expires: number;
}

/** Longest URL that is rendered; longer ones get the plain page. */
const MAX_URL = 2048;

/** Cache-Control of rendered pages: short, shared, served stale while a fresh one renders. */
export const PAGE_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=60';
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

export function composePage(template: PageTemplate, page: SsrRenderResult): string {
  const theme = page.theme === 'system' ? '' : ` data-theme="${page.theme}"`;
  return (
    `${template.beforeHtml}<html lang="${escapeHtml(page.lang)}" dir="${page.dir}"${theme}>` +
    template.headStart +
    headTags(page.head, page.hoisted) +
    // The accent color before the stylesheet (it is more specific); never a way out of <style>.
    (page.css ? `<style>${page.css.replace(/</g, '')}</style>` : '') +
    template.headRestAndBodyStart +
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

/** Thrown when too many pages wait for a render: the caller sends the plain page. */
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
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly limiter: Limiter;
  /** Set when the bundle cannot be loaded: every page is the plain one, logged once. */
  private unavailable = false;

  constructor(private readonly options: SsrPagesOptions) {
    this.source = publicDocumentSource(options.docs, { subscription: options.subscription });
    this.ttlMs = (options.cacheSeconds ?? 5) * 1000;
    this.maxEntries = options.cacheEntries ?? 16;
    this.maxBytes = options.cacheBytes ?? 1024 * 1024;
    this.limiter = new Limiter(options.concurrency ?? 2, options.maxWaiting ?? 32);
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

  /**
   * Sends the rendered page for a public client route. Resolves false when the
   * page could not be rendered (the caller sends the plain page).
   */
  async send(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (this.unavailable || req.url.length > MAX_URL) return false;
    let page: RenderedPage;
    try {
      page = await this.render(req);
    } catch (err) {
      if (err instanceof RenderQueueFull) req.log.warn(err.message);
      else req.log.error({ err }, 'Server-side rendering failed; sending the client-rendered page');
      return false;
    }

    const personal = isPersonalPath(req.url);
    reply
      .header('Cache-Control', personal ? PRIVATE_CACHE_CONTROL : PAGE_CACHE_CONTROL)
      // Language and theme come from these headers.
      .header('Vary', 'Accept-Language, Cookie, Accept-Encoding')
      .header('ETag', page.etag);
    if (!personal && page.status === 200 && req.headers['if-none-match'] === page.etag) {
      await reply.status(304).send();
      return true;
    }
    await sendPage(req, reply.status(page.status), page);
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
      if (err instanceof RenderQueueFull) req.log.warn(err.message);
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

  private async renderPage(module: RenderModule, input: Pick<SsrRenderInput, 'url' | 'cookie' | 'acceptLanguage' | 'form'>): Promise<RenderedPage> {
    const result = await module.render({ ...input, source: this.source, baseUrl: this.options.baseUrl, now: Date.now() });
    const body = Buffer.from(composePage(this.loadTemplate(), result));
    const gzip = gzipSync(body, { level: GZIP_LEVEL });
    return { status: result.status, body, gzip, etag: etagOf(body), expires: Date.now() + this.ttlMs };
  }

  private async render(req: FastifyRequest): Promise<RenderedPage> {
    const module = await this.module_();
    const request = this.inputOf(req);
    // Personal pages (a token in the URL) are neither kept nor shared between requests,
    // in any spelling of the path (the router matches /SUBSCRIPTION/manage as well).
    if (isPersonalPath(request.url)) return this.limiter.run(() => this.renderPage(module, request));
    // Rendered without the query parameters no page reads: /?x=1, /?x=2 ... share one
    // render instead of forcing a new one each (the cache key is the same URL).
    const input = { ...request, url: module.pageUrl(request.url) };
    const key = module.cacheKey(input);
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expires > now) return cached;
    if (cached) this.evict(key);

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
    return pending;
  }

  private remember(key: string, page: RenderedPage): void {
    if (this.ttlMs <= 0 || pageBytes(page) > this.maxBytes) return;
    this.evict(key);
    this.cache.set(key, page);
    this.cachedBytes += pageBytes(page);
    // Oldest first: drop beyond the limits.
    while (this.cache.size > this.maxEntries || this.cachedBytes > this.maxBytes) this.evict(this.cache.keys().next().value!);
    // Expired pages do not wait for the next request of their key.
    setTimeout(() => {
      if (this.cache.get(key) === page) this.evict(key);
    }, this.ttlMs).unref();
  }

  private evict(key: string): void {
    const page = this.cache.get(key);
    if (!page) return;
    this.cache.delete(key);
    this.cachedBytes -= pageBytes(page);
  }
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
